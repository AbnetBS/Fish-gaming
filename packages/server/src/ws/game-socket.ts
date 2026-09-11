import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../security/tokens.js';
import type { RoundManager, ClientConnection } from '../sim/round-manager.js';
import { findUserById } from '../modules/users/service.js';
import { getWallet } from '../modules/wallet/ledger.js';
import { isMaintenanceMode } from '../modules/config/service.js';
import { activeSession, betOptionsFor, joinRoom, listRooms } from '../modules/game/service.js';
import { readPlayLimits } from '../modules/game/limits.js';
import type { ClientMessage, ServerMessage } from '@reef/shared';

/**
 * Real-time gameplay transport.
 *
 * The socket is an *event* channel, not a state channel:
 *  - clients send intents (join / fire / aim) and never send results;
 *  - the server replies with an ack for the intent and broadcasts only
 *    meaningful events (spawn, despawn, hit, defeat, join, leave, wave, round)
 *    plus throttled deltas;
 *  - no animation frames ever cross the network — clients derive positions from
 *    the same deterministic motion function the server runs.
 */

const MAX_MESSAGE_BYTES = 2048;
const AUTH_TIMEOUT_MS = 10_000;
/** Messages per second a single socket may send before it is dropped. */
const MESSAGE_RATE_LIMIT = 60;
const AIM_RATE_LIMIT = 30;

/** All live gameplay sockets, kept module-level so notices can reach them. */
export const gameConnections = new Set<ClientConnection>();

export function registerGameSocket(app: FastifyInstance, manager: () => RoundManager): void {

  app.get('/ws/game', { websocket: true } as any, (socket: any, request: any) => {
    let connection: ClientConnection | null = null;
    let authenticated = false;
    let tokens = MESSAGE_RATE_LIMIT;
    let aimTokens = AIM_RATE_LIMIT;
    let lastRefill = Date.now();

    const closeSocket = (code: number, reason: string) => {
      try {
        socket.close?.(code, reason);
      } catch {
        try {
          socket.terminate?.();
        } catch {
          /* already gone */
        }
      }
    };

    const send = (message: ServerMessage) => {
      if (socket.readyState !== 1) return;
      try {
        socket.send(JSON.stringify(message));
      } catch {
        /* closing */
      }
    };

    const authTimer = setTimeout(() => {
      if (!authenticated) closeSocket(4001, 'Authentication timeout.');
    }, AUTH_TIMEOUT_MS);

    socket.on('message', (raw: Buffer | string) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        if (text.length > MAX_MESSAGE_BYTES) return closeSocket(1009, 'Message too large.');

        const now = Date.now();
        const refill = ((now - lastRefill) / 1000) * MESSAGE_RATE_LIMIT;
        tokens = Math.min(MESSAGE_RATE_LIMIT, tokens + refill);
        aimTokens = Math.min(AIM_RATE_LIMIT, aimTokens + ((now - lastRefill) / 1000) * AIM_RATE_LIMIT);
        lastRefill = now;
        if (tokens < 1) return closeSocket(1008, 'Sending too fast.');
        tokens -= 1;

        let data: ClientMessage & { type?: string };
        try {
          data = JSON.parse(text);
        } catch {
          send({ type: 'notice', level: 'error', message: 'Malformed message.' });
          return;
        }
        if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

        /* ------------------------------ handshake ------------------------------ */
        if (!authenticated) {
          if (data.type !== 'auth') {
            send({ type: 'authError', message: 'Authenticate before playing.' });
            return;
          }
          const token = (data as any).token ?? request?.cookies?.rr_at;
          const identity = authenticate(typeof token === 'string' ? token : undefined);
          if (!identity) {
            send({ type: 'authError', message: 'Your session expired. Please sign in again.' });
            return closeSocket(4001, 'Unauthenticated.');
          }
          clearTimeout(authTimer);
          authenticated = true;
          connection = {
            ws: socket,
            userId: identity.userId,
            username: identity.username,
            avatarSeed: identity.avatarSeed,
            roomId: null,
            lastAngle: -Math.PI / 2,
            cannonKey: 'tidecaster',
            alive: true,
            lastBalance: identity.balance,
            pendingRefs: new Map(),
          };
          gameConnections.add(connection);
          send({
            type: 'welcome',
            userId: identity.userId,
            username: identity.username,
            serverTime: Date.now(),
            flags: { realMoneyEnabled: false, maintenance: isMaintenanceMode(getDb()) },
          });
          send({
            type: 'rooms',
            rooms: listRooms(getDb(), {
              playerCount: (roomId) => manager().roomPlayerCount(roomId),
              roundIdOf: (roomId) => manager().currentRoundId(roomId),
            }),
          });
          // Resume the player's session if they were mid-round when the socket dropped.
          const resumed = activeSession(getDb(), identity.userId);
          if (resumed) {
            try {
              attach(connection, resumed.roomId);
            } catch (err) {
              send(blockedMessage(connection, err) ?? { type: 'notice', level: 'warn', message: 'That round has ended. Pick a room to continue.' });
            }
          }
          return;
        }

        /* -------------------------------- actions -------------------------------- */
        const conn = connection as ClientConnection;
        switch (data.type) {
          case 'join': {
            const roomId = typeof (data as any).roomId === 'string' ? (data as any).roomId.slice(0, 64) : '';
            if (!roomId) return send({ type: 'notice', level: 'error', message: 'Invalid room.' });
            try {
              attach(conn, roomId);
            } catch (err) {
              send(blockedMessage(conn, err) ?? { type: 'notice', level: 'warn', message: joinFallback(err) });
            }
            return;
          }

          case 'fire': {
            const body = data as any;
            const clientRef = typeof body.clientRef === 'string' ? body.clientRef.slice(0, 64) : '';
            if (clientRef.length < 8) return send({ type: 'notice', level: 'error', message: 'Invalid shot reference.' });
            const result = manager().fire(conn, {
              clientRef,
              cannonKey: String(body.cannonKey ?? '').slice(0, 32),
              angle: Number(body.angle),
              originX: Number(body.originX),
              originY: Number(body.originY),
            });
            if (!result.ok) {
              send({
                type: 'shot',
                ack: {
                  ok: false,
                  clientRef,
                  code: result.code,
                  message: result.message,
                  cost: 0,
                  damage: 0,
                  angle: 0,
                  speed: 0,
                  originX: 0,
                  originY: 0,
                  balance: conn.lastBalance,
                  waitMs: result.waitMs,
                } as any,
              });
            }
            return;
          }

          case 'aim': {
            const angle = Number((data as any).angle);
            if (!Number.isFinite(angle)) return;
            if (aimTokens < 1) return; // silently drop excess aim updates
            aimTokens -= 1;
            manager().setAim(conn, angle);
            return;
          }

          case 'setCannon': {
            const cannonKey = String((data as any).cannonKey ?? '').slice(0, 32);
            const result = manager().setCannon(conn, cannonKey);
            if (!result.ok) {
              send({ type: 'notice', level: 'warn', message: result.message ?? 'That cannon is not available here.' });
              return;
            }
            conn.cannonKey = cannonKey;
            const session = activeSession(getDb(), conn.userId);
            if (session) {
              const option = betOptionsFor(getDb(), session.roomId, cannonKey).options.find((o) => o.key === cannonKey);
              getDb().run("UPDATE game_sessions SET cannon_id = (SELECT id FROM cannons WHERE key = ?) WHERE user_id = ? AND status = 'ACTIVE'", cannonKey, conn.userId);
              send({
                type: 'notice',
                level: 'info',
                message: option ? `${option.name} equipped — ${option.shotCost} demo coins per shot.` : 'Cannon equipped.',
              });
            }
            return;
          }

          case 'resync': {
            if (!conn.roomId) return;
            const snapshot = manager().snapshotFor(conn.roomId);
            if (snapshot) send({ type: 'snapshot', snapshot });
            return;
          }

          case 'leave': {
            manager().detach(conn);
            send({ type: 'left' });
            return;
          }

          case 'ping':
            return send({ type: 'pong', t: Number((data as any).t) || Date.now() });

          default:
            return;
        }
      } catch (err) {
        logger.error('Socket message error', { err: String(err) });
        send({ type: 'notice', level: 'error', message: 'Something went wrong. Please reconnect.' });
      }
    });

    /** Attach a socket to a room: creates/joins the DB session and the sim seat. */
    const attach = (conn: ClientConnection, roomIdOrKey: string) => {
      const db = getDb();
      const room = db.get<any>("SELECT * FROM game_rooms WHERE (id = ? OR key = ?) AND status = 'ACTIVE'", roomIdOrKey, roomIdOrKey);
      if (!room) throw new Error('ROOM_NOT_FOUND');
      if (isMaintenanceMode(db)) throw new Error('MAINTENANCE');

      const mgr = manager();
      let session = activeSession(db, conn.userId);
      if (session && session.roomId === room.id) {
        // Resuming a session that was opened over REST: adopt the cannon that
        // session was created with, otherwise the player would keep firing a
        // weapon the room does not accept.
        const resumed = db.get<{ key: string }>('SELECT key FROM cannons WHERE id = ?', session.cannonId ?? '');
        if (resumed?.key) conn.cannonKey = resumed.key;
      } else {
        const preferred = session ? db.get<{ key: string }>('SELECT key FROM cannons WHERE id = ?', session.cannonId ?? '')?.key : undefined;
        const joined = joinRoom(db, conn.userId, room.id, preferred ?? conn.cannonKey);
        session = joined.session;
        conn.cannonKey = joined.cannonKey;
      }
      // The room may not accept the resumed cannon at all (config changed since):
      // fall back to the first legal option instead of rejecting every shot.
      const legality = betOptionsFor(db, room.id, conn.cannonKey);
      if (!legality.options.some((option) => option.key === conn.cannonKey && option.legal)) {
        conn.cannonKey = legality.cannonKey;
      }
      const { runtime, player, seat } = mgr.attach(conn, room.id);
      conn.roomId = room.id;
      conn.lastAngle = player.angle;
      const wallet = getWallet(db, conn.userId);
      conn.lastBalance = wallet.balance;
      const snapshot = mgr.snapshotFor(room.id);
      const limits = readPlayLimits(db, conn.userId);
      const limitsView = {
        limitMin: limits.limitMin,
        minutesPlayedToday: limits.minutesPlayedToday,
        minutesRemaining: Number.isFinite(limits.minutesRemaining) ? limits.minutesRemaining : null,
      };
      send({
        type: 'joined',
        roomId: room.id,
        roundId: runtime.roundId,
        configVersion: runtime.config.version,
        seat,
        snapshot: (snapshot ?? runtime.sim.snapshot()) as any,
        balance: wallet.balance,
        cannonKey: conn.cannonKey,
        betOptions: betOptionsFor(db, room.id, conn.cannonKey).options.map((o) => ({
          key: o.key,
          name: o.name,
          level: o.level,
          power: o.power,
          shotCost: o.shotCost,
          fireRate: o.fireRate,
          legal: o.legal,
        })),
        limits: limitsView,
      });
      mgr.broadcastPlayerJoined(room.id, player);
    };

    socket.on('close', () => {
      clearTimeout(authTimer);
      const target = connection;
      if (target) {
        try {
          manager().detach(target);
        } catch {
          /* ignore */
        }
        gameConnections.delete(target);
      }
    });

    socket.on('error', (err: unknown) => logger.warn('Socket error', { err: String(err) }));

  });
}

/**
 * Player-protection refusals become a typed `limit` message so the client can
 * show the real reason (and stop offering FIRE) instead of a toast.
 */
function blockedMessage(conn: ClientConnection, err: unknown): ServerMessage | null {
  const code = (err as { code?: string })?.code;
  if (code !== 'SELF_EXCLUDED' && code !== 'SESSION_LIMIT_REACHED' && code !== 'ACCOUNT_SUSPENDED') return null;
  const limits = readPlayLimits(getDb(), conn.userId);
  return {
    type: 'limit',
    kind: code === 'ACCOUNT_SUSPENDED' ? 'ACCOUNT_BLOCKED' : code === 'SELF_EXCLUDED' ? 'SELF_EXCLUDED' : 'SESSION_LIMIT',
    message: err instanceof Error ? err.message : 'Play is blocked for this account.',
    limitMin: limits.limitMin,
    minutesPlayedToday: limits.minutesPlayedToday,
    until: limits.selfExcludedUntil,
  };
}

function joinFallback(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === 'ROOM_FULL') return 'Room is full. Try another room.';
  if (code === 'MAINTENANCE') return 'The game is under maintenance. Please try again shortly.';
  if (code === 'BET_OUT_OF_RANGE') return 'No cannon fits this room. Try another room.';
  if (err instanceof Error && err.message && err.message.length < 200) return err.message;
  return 'That room is not available right now.';
}

function authenticate(token: string | undefined): { userId: string; username: string; avatarSeed: string; balance: number } | null {
  if (!token) return null;
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return null;
  }
  const db = getDb();
  const row = findUserById(db, claims.sub);
  if (!row) return null;
  if (row.status === 'SUSPENDED' || row.status === 'CLOSED') return null;
  const wallet = db.get<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', row.id);
  return { userId: row.id, username: row.username, avatarSeed: row.avatar_seed, balance: wallet?.balance ?? 0 };
}

/** Notifies every connected player, used for maintenance + shutdown notices. */
export function broadcastToAll(message: ServerMessage): void {
  const text = JSON.stringify(message);
  for (const conn of gameConnections) {
    if (conn.ws.readyState !== 1) continue;
    try {
      conn.ws.send(text);
    } catch {
      conn.alive = false;
    }
  }
}

export function shutdownSockets(reason = 'The server is restarting. Please reconnect.'): void {
  for (const conn of gameConnections) {
    if (conn.ws.readyState !== 1) continue;
    try {
      conn.ws.send(JSON.stringify({ type: 'notice', level: 'warn', message: reason }));
      conn.ws.close?.(1001, reason);
    } catch {
      /* ignore */
    }
  }
}
