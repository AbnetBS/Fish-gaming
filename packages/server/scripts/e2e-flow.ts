/* eslint-disable no-console */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * End-to-end flow test.
 *
 * Boots the real server (HTTP + WebSocket + SQLite) on an ephemeral port and
 * walks the exact journeys the product promises:
 *
 *   PLAYER: register → 10,000 demo coins → pick room → join over WS → aim →
 *           fire → hit → kill → reward → balance moves → history → exit
 *   ADMIN:  login → dashboard → edit fish → publish config → audit entry →
 *           new round uses the new numbers
 *
 * Run with `npm run e2e:flow`. Exits non-zero on any failed step, so it can be
 * dropped straight into CI.
 */

const root = path.resolve(import.meta.dirname, '../..');
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.PORT = process.env.PORT ?? '0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reef-e2e-'));
process.env.DB_FILE = path.join(tmp, 'e2e.db');
process.env.JWT_SECRET = 'e2e-only-secret-0000000000000000000000000000';
process.env.BOOTSTRAP_ADMIN_EMAIL = 'e2e-admin@reefraiders.local';
process.env.BOOTSTRAP_ADMIN_USERNAME = 'e2eadm';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'E2eAdmin!2345';

const { setEnv, loadEnv } = await import('../src/config/env.js');
setEnv(loadEnv());
const { bootstrap } = await import('../src/index.js');
const { getDb } = await import('../src/db/index.js');

let failures = 0;
let step = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  step += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const handle = await bootstrap();
const address = handle.app.server.address();
const port = typeof address === 'object' && address ? address.port : Number(process.env.PORT);
const base = `http://127.0.0.1:${port}`;

async function api(
  token: string | null,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

section('1 · platform health');
{
  const health = await api(null, 'GET', '/api/health');
  check('health endpoint responds', health.status === 200 && health.json.status === 'ok', health.json);
  const meta = await api(null, 'GET', '/api/meta');
  check('currency is labelled DEMO COINS', meta.json.currency?.label === 'DEMO COINS', meta.json.currency);
  check('real money is disabled', meta.json.flags?.realMoneyEnabled === false, meta.json.flags);
  check('starting balance is 10000', meta.json.currency?.startingBalance === 10_000, meta.json.currency);
}

section('2 · registration grants demo coins');
const username = `angler${Date.now().toString(36).slice(-5)}`;
const email = `${username}@example.com`;
const password = 'Reef!Passw0rd';
let token = '';
{
  const register = await api(null, 'POST', '/api/auth/register', { username, email, password, acceptTerms: true });
  check('register returns 201', register.status === 201, register.json);
  token = register.json.accessToken;
  check('access token issued', typeof token === 'string' && token.length > 20);
  check('wallet starts at 10,000 demo coins', register.json.wallet?.balance === 10_000, register.json.wallet);
  const me = await api(token, 'GET', '/api/me');
  check('profile reads back with role USER', me.json.user?.role === 'USER', me.json.user);
  const dup = await api(null, 'POST', '/api/auth/register', { username, email, password, acceptTerms: true });
  check('duplicate email rejected with 409', dup.status === 409, dup.json);
}

section('3 · rooms and joining');
let roomKey = 'shallow_lagoon';
let roomId = '';
{
  const rooms = await api(token, 'GET', '/api/game/rooms');
  check('room list returns 4 rooms', Array.isArray(rooms.json.rooms) && rooms.json.rooms.length === 4, rooms.json.rooms);
  roomKey = rooms.json.rooms[0].key;
  roomId = rooms.json.rooms[0].id;
  const join = await api(token, 'POST', '/api/game/join', { roomKey });
  check('join succeeds and returns a round id', join.status === 200 && /^RND-\d{4}-\d{6}$/.test(join.json.roundId ?? ''), join.json);
  check('join returns a cannon compatible with the room bet range', Array.isArray(join.json.betOptions) && join.json.betOptions.some((o: any) => o.legal), join.json.betOptions);
}

section('4 · live play over the WebSocket');
type Msg = { type: string; [k: string]: any };
const received: Msg[] = [];
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/game`);
let joined = false;
let balanceAfter: number | null = null;
let kills = 0;
let rewards = 0;
let shotAcks = 0;
let rejections = 0;
let serverRoundId = '';

await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('websocket flow timed out')), 25_000);
  const finish = (): void => {
    clearTimeout(timeout);
    resolve();
  };

  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));

  ws.addEventListener('message', (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as Msg;
    received.push(message);
    if (message.type === 'welcome') {
      ws.send(JSON.stringify({ type: 'join', roomId: roomKey }));
    }
    if (message.type === 'joined') {
      joined = true;
      serverRoundId = message.roundId;
      balanceAfter = message.balance;
      // Aim straight up and fire a volley; the reef is pre-populated so some
      // shots will land.
      ws.send(JSON.stringify({ type: 'aim', angle: -Math.PI / 2 }));
      let shots = 0;
      const fireNext = (): void => {
        if (shots++ > 45) {
          setTimeout(finish, 1200);
          return;
        }
        ws.send(
          JSON.stringify({
            type: 'fire',
            clientRef: `e2e-${shots}-${Math.random().toString(36).slice(2, 8)}`,
            cannonKey: message.cannonKey,
            angle: -Math.PI / 2 + (Math.random() - 0.5) * 1.1,
            originX: message.seat.x,
            originY: message.seat.y,
          }),
        );
        setTimeout(fireNext, 120);
      };
      fireNext();
    }
    if (message.type === 'shot') {
      if (message.ack?.ok) shotAcks += 1;
      else rejections += 1;
      if (typeof message.ack?.balance === 'number') balanceAfter = message.ack.balance;
    }
    if (message.type === 'defeat' && message.event?.mine) {
      kills += 1;
      rewards += message.event.reward ?? 0;
    }
    if (message.type === 'balance' && typeof message.balance === 'number') balanceAfter = message.balance;
    if (message.type === 'notice' && message.level === 'error') {
      clearTimeout(timeout);
      reject(new Error(`server notice: ${message.message}`));
    }
  });

  ws.addEventListener('error', () => {
    clearTimeout(timeout);
    reject(new Error('websocket error'));
  });
}).catch((err) => {
  check('websocket gameplay completed', false, String(err));
});

check('socket authenticated and joined the room', joined);
check('server sent world snapshots', received.some((m) => m.type === 'snapshot') || received.some((m) => m.type === 'delta'));
check('shots were accepted and paid for', shotAcks > 0, { shotAcks, rejections });
const fishSeen = received.filter((m) => m.type === 'delta').flatMap((m) => (m.delta?.add ?? []));
const spawnedTotal = fishSeen.length + (received.find((m) => m.type === 'snapshot')?.snapshot?.fish?.length ?? 0);
check('fish were spawned into the room', spawnedTotal > 0, { spawnedTotal });
check('balance changed while playing', typeof balanceAfter === 'number' && balanceAfter !== 10_000, { balanceAfter });
check('at least one fish was defeated during the volley', kills > 0, { kills, rewards });
check('kills produced demo rewards', rewards > 0, { rewards });

section('5 · wallet ledger and history reflect the session');
{
  const wallet = await api(token, 'GET', '/api/wallet');
  check('wallet endpoint agrees with the socket balance', wallet.json.wallet?.balance === balanceAfter, {
    http: wallet.json.wallet?.balance,
    socket: balanceAfter,
  });
  const tx = await api(token, 'GET', '/api/wallet/transactions?limit=100');
  const types = new Set((tx.json.items ?? []).map((t: any) => t.type));
  check('ledger contains a DEMO_CREDIT welcome entry', types.has('DEMO_CREDIT'), [...types]);
  check('ledger contains BET entries for the shots', types.has('BET'), [...types]);
  if (kills > 0) check('ledger contains WIN entries for the kills', types.has('WIN'), [...types]);
  const bets = (tx.json.items ?? []).filter((t: any) => t.type === 'BET');
  check(
    'no ledger row was written twice for the same shot',
    new Set(bets.map((t: any) => t.idempotencyKey)).size === bets.length,
    { bets: bets.length },
  );
  check('ledger chain is continuous (before + amount = after)', (tx.json.items ?? []).every((t: any) => t.balanceAfter === t.balanceBefore + t.amount));

  const history = await api(token, 'GET', '/api/history?limit=100');
  check('game history recorded the shots', (history.json.items ?? []).length >= shotAcks, {
    history: history.json.total,
    acks: shotAcks,
  });
  const entry = (history.json.items ?? [])[0];
  check('history rows carry room, cost, reward and result', !!entry && 'roomName' in entry && 'shotCost' in entry && 'result' in entry, entry);
  if (kills > 0) {
    check('a KILL row exists in history', (history.json.items ?? []).some((h: any) => h.result === 'KILL' && h.reward > 0));
  }

  const sessions = await api(token, 'GET', '/api/sessions');
  check('session summary lists the room played', (sessions.json.items ?? []).length >= 1, sessions.json.items?.[0]);

  const events = getDb().all<any>('SELECT event_type, COUNT(*) c FROM game_events WHERE round_id = ? GROUP BY event_type', serverRoundId);
  const byType = new Map(events.map((e) => [e.event_type, e.c]));
  check('round logged PLAYER_JOINED', (byType.get('PLAYER_JOINED') ?? 0) >= 1, [...byType.entries()]);
  check('round logged PLAYER_SHOT', (byType.get('PLAYER_SHOT') ?? 0) >= 1, [...byType.entries()]);
  check('round logged FISH_SPAWNED', (byType.get('FISH_SPAWNED') ?? 0) >= 1, [...byType.entries()]);
  if (kills > 0) check('round logged FISH_DEFEATED', (byType.get('FISH_DEFEATED') ?? 0) >= 1, [...byType.entries()]);

  const roundRow = getDb().get<any>('SELECT config_version FROM game_rounds WHERE id = ?', serverRoundId);
  check('round stores the configuration version it used', /^\d+\.\d+\.\d+$/.test(roundRow?.config_version ?? ''), roundRow);
}

section('6 · duplicate and tampered requests are refused');
{
  // Let the fire-rate window close so a duplicate is judged on idempotency
  // rather than on cadence.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const balanceBefore = (await api(token, 'GET', '/api/wallet')).json.wallet.balance;
  const first = await api(token, 'POST', '/api/game/fire', {
    clientRef: 'e2e-replay-ref',
    cannonKey: 'reef_breaker',
    angle: -Math.PI / 2,
    originX: 960,
    originY: 984,
  });
  check('a fresh shot is accepted', first.status === 200 && first.json.ok === true, first.json);
  const afterFirst = (await api(token, 'GET', '/api/wallet')).json.wallet.balance;
  check('the accepted shot cost exactly one bet', afterFirst === balanceBefore - 5, { balanceBefore, afterFirst });

  // Same reference again, immediately: must be recognised as a replay of the
  // shot already recorded, not charged again and not refused as "too fast".
  const replay = await api(token, 'POST', '/api/game/fire', {
    clientRef: 'e2e-replay-ref',
    cannonKey: 'reef_breaker',
    angle: -Math.PI / 2,
    originX: 960,
    originY: 984,
  });
  check('the same clientRef never charges twice', replay.status === 200 && replay.json.ack?.replayed === true, replay.json);
  const afterReplay = (await api(token, 'GET', '/api/wallet')).json.wallet.balance;
  check('replayed shot left the balance untouched', afterReplay === afterFirst, { afterFirst, afterReplay });
  check(
    'only one shot row exists for that reference',
    getDb().scalar<number>('SELECT COUNT(*) FROM player_shots WHERE client_ref = ?', 'e2e-replay-ref') === 1,
  );

  const invented = await api(token, 'POST', '/api/game/fire', {
    clientRef: 'e2e-invent-0001',
    cannonKey: 'reef_breaker',
    angle: -Math.PI / 2,
    originX: 960,
    originY: 984,
    reward: 999999,
    cost: 0,
  } as any);
  check('client-invented reward/cost fields are rejected by the strict schema', invented.status === 400, { status: invented.status, json: invented.json });

  const forged = await api('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.notsoreal', 'GET', '/api/me');
  check('a forged token is rejected', forged.status === 401, forged.json);

  const bogusCannon = await api(token, 'POST', '/api/game/fire', {
    clientRef: 'e2e-bogus-cannon-1',
    cannonKey: 'debug_cannon',
    angle: -Math.PI / 2,
    originX: 960,
    originY: 984,
  });
  check('an unknown cannon cannot be used', bogusCannon.status >= 400 && bogusCannon.json.error?.code === 'WEAPON_UNAVAILABLE', bogusCannon.json);
}

ws.close();
await api(token, 'POST', '/api/game/leave');

section('7 · leaderboard');
{
  const board = await api(null, 'GET', '/api/leaderboard/daily');
  check('leaderboard answers with an items array', Array.isArray(board.json.items), board.json);
  if (kills > 0) {
    check('the player appears on the daily board', board.json.items.some((e: any) => e.username === username), board.json.items?.slice(0, 5));
    check('board entries expose no private fields', board.json.items.every((e: any) => !('email' in e) && !('id' in e)), board.json.items?.[0]);
  }
}

section('8 · admin journey');
let adminToken = '';
{
  const adminLogin = await api(null, 'POST', '/api/auth/login', {
    identifier: 'e2e-admin@reefraiders.local',
    password: 'E2eAdmin!2345',
  });
  check('admin can log in', adminLogin.status === 200, adminLogin.json);
  adminToken = adminLogin.json.accessToken;
  check('admin token carries a role', adminLogin.json.user?.role === 'SUPER_ADMIN', adminLogin.json.user);

  const dash = await api(adminToken, 'GET', '/api/admin/dashboard');
  check('admin dashboard returns demo statistics', dash.status === 200 && typeof dash.json.totalUsers === 'number', dash.json);
  check('admin dashboard reports games today', (dash.json.gamesToday ?? 0) >= 1, { gamesToday: dash.json.gamesToday });
  check('admin dashboard reports shots today', (dash.json.shotsToday ?? 0) >= 1, { shotsToday: dash.json.shotsToday });
  check('ledger reconciliation is clean', (dash.json.ledgerIntegrity?.mismatches ?? []).length === 0, dash.json.ledgerIntegrity);

  const players = await api(null, 'POST', '/api/admin/fish', { key: 'x', name: 'Y' });
  check('a non-admin cannot write the game config', players.status === 401, players.json);

  const fish = await api(adminToken, 'GET', '/api/admin/fish');
  const target = (fish.json.items ?? []).find((f: any) => f.key === 'coral_wrasse');
  check('admin can read the fish table', !!target, fish.json.items?.length);
  const original = { health: target.health, reward: target.reward, speed: target.speed };
  const updated = await api(adminToken, 'PATCH', `/api/admin/fish/${target.id}`, { health: 6, reward: 11, speed: 133 });
  check('admin can change health, reward and speed', updated.status === 200 && updated.json.fish.health === 6 && updated.json.fish.reward === 11, updated.json);
  check('the change is reported as a diff', updated.json.changed?.reward?.from === original.reward && updated.json.changed?.reward?.to === 11, updated.json.changed);

  const beforePublish = await api(null, 'GET', '/api/config');
  check('published config still shows the old numbers before publishing', beforePublish.json.fish.find((f: any) => f.key === 'coral_wrasse').reward === original.reward, beforePublish.json.version);

  const published = await api(adminToken, 'POST', '/api/admin/config/publish', { notes: 'e2e: buff coral wrasse' });
  check('publishing creates a new configuration version', /^\d+\.\d+\.\d+$/.test(published.json.version ?? '') && published.json.version !== beforePublish.json.version, published.json);

  const afterPublish = await api(null, 'GET', '/api/config');
  check('new config is served to clients', afterPublish.json.version === published.json.version, afterPublish.json.version);
  check('the new numbers reach the game', afterPublish.json.fish.find((f: any) => f.key === 'coral_wrasse').reward === 11, afterPublish.json.fish.find((f: any) => f.key === 'coral_wrasse'));

  const audit = await api(adminToken, 'GET', '/api/admin/audit?limit=20');
  const actions = (audit.json.items ?? []).map((a: any) => a.action);
  check('audit log recorded the fish change', actions.includes('FISH_UPDATE'), actions.slice(0, 6));
  check('audit log recorded the publish', actions.includes('CONFIG_PUBLISH'), actions.slice(0, 6));
  const fishAudit = (audit.json.items ?? []).find((a: any) => a.action === 'FISH_UPDATE');
  check('audit entry stores before and after values', !!fishAudit?.previousValue && !!fishAudit?.newValue, fishAudit);

  const rooms = await api(adminToken, 'GET', '/api/admin/rooms');
  const room = (rooms.json.items ?? []).find((r: any) => r.key === roomKey);
  const patchedRoom = await api(adminToken, 'PATCH', `/api/admin/rooms/${room.id}`, { maxPlayers: 6, minBet: 2 });
  check('admin can reconfigure a room', patchedRoom.status === 200 && patchedRoom.json.room.maxPlayers === 6, patchedRoom.json);
  await api(adminToken, 'PATCH', `/api/admin/rooms/${room.id}`, { maxPlayers: room.maxPlayers, minBet: room.minBet });

  const badPatch = await api(adminToken, 'PATCH', `/api/admin/fish/${target.id}`, { health: -3 });
  check('invalid economy values are rejected', badPatch.status === 400, badPatch.json);

  const maintenanceOn = await api(adminToken, 'POST', '/api/admin/maintenance', { enabled: true, reason: 'e2e window' });
  check('maintenance mode can be enabled', maintenanceOn.json.maintenance === true, maintenanceOn.json);
  const blocked = await api(token, 'POST', '/api/game/join', { roomKey });
  check('maintenance blocks joining a room', blocked.status === 409 && blocked.json.error.code === 'MAINTENANCE', blocked.json);
  const maintenanceOff = await api(adminToken, 'POST', '/api/admin/maintenance', { enabled: false });
  check('maintenance mode can be disabled', maintenanceOff.json.maintenance === false, maintenanceOff.json);
  const unblocked = await api(token, 'POST', '/api/game/join', { roomKey });
  check('rooms reopen after maintenance', unblocked.status === 200, unblocked.json);

  const reports = await api(adminToken, 'GET', '/api/admin/reports/overview');
  check('reports include live room state', Array.isArray(reports.json.liveRooms), reports.json.liveRooms);
  const rounds = await api(adminToken, 'GET', '/api/admin/rounds?limit=5');
  const playedRound = (rounds.json.items ?? []).find((r: any) => r.roundId === serverRoundId);
  check('the played round is reported with wager and reward totals', !!playedRound && playedRound.shots >= 1, playedRound);
  if (playedRound) {
    const roundAudit = await api(adminToken, 'GET', `/api/admin/rounds/${encodeURIComponent(playedRound.roundId)}/audit`);
    check('a round can be audited against its exact configuration', roundAudit.json.configuration?.version === playedRound.configVersion, {
      auditVersion: roundAudit.json.configuration?.version,
      roundVersion: playedRound.configVersion,
    });
  }

  const suspended = await api(adminToken, 'POST', `/api/admin/users/${encodeURIComponent(fish.json.items ? '' : '')}/status`, { status: 'SUSPENDED', reason: 'x' });
  check('malformed admin writes fail cleanly rather than 500', suspended.status === 400 || suspended.status === 404, suspended.status);
}

section('9 · new round uses the updated configuration');
{
  const join = await api(token, 'POST', '/api/game/join', { roomKey });
  const roundId = join.json.roundId;
  const row = getDb().get<any>('SELECT config_version FROM game_rounds WHERE id = ?', roundId);
  const published = await api(null, 'GET', '/api/config');
  check('the fresh round is pinned to the newly published version', row?.config_version === published.json.version, { round: row?.config_version, active: published.json.version });
}

section('10 · player protection is enforced, not decorative');
{
  const me = await api(token, 'GET', '/api/me');
  const userId = me.json.user.id as string;

  const saved = await api(token, 'PATCH', '/api/me/profile', { sessionLimitMin: 1 });
  check('player can set a daily play limit', saved.status === 200 && saved.json.profile?.sessionLimitMin === 1, saved.json);

  const state = await api(token, 'GET', '/api/me/limits');
  check('the limit reads back from the same rows the game enforces', state.status === 200 && state.json.limitMin === 1, state.json);

  // Pretend this player has already played ten minutes today, then try to keep playing.
  getDb().run(
    "UPDATE game_sessions SET started_at = ? WHERE user_id = ? AND status = 'ACTIVE'",
    new Date(Date.now() - 10 * 60_000).toISOString(),
    userId,
  );

  const blockedJoin = await api(token, 'POST', '/api/game/join', { roomKey });
  check(
    'joining is refused with a reason once the budget is spent',
    blockedJoin.status === 403 && blockedJoin.json.error?.code === 'SESSION_LIMIT_REACHED',
    blockedJoin.json,
  );

  const blockedFire = await api(token, 'POST', '/api/game/fire', {
    clientRef: `e2e-limit-${Date.now().toString(36)}`,
    cannonKey: roomKey === 'shallow_lagoon' ? 'reef_breaker' : 'tidecaster',
    angle: -1.5,
    originX: 960,
    originY: 984,
  });
  check('firing is refused too, so the limit cannot be worked around', blockedFire.status >= 400 && blockedFire.json.error?.code === 'SESSION_LIMIT_REACHED', blockedFire.json);

  const balanceAfter = await api(token, 'GET', '/api/me');
  check('the refused shot cost nothing', balanceAfter.json.wallet?.balance === me.json.wallet?.balance, {
    before: me.json.wallet?.balance,
    after: balanceAfter.json.wallet?.balance,
  });

  const released = await api(token, 'PATCH', '/api/me/profile', { sessionLimitMin: null });
  check('removing the limit is allowed', released.status === 200, released.json);
  const rejoined = await api(token, 'POST', '/api/game/join', { roomKey });
  check('play resumes once the player raises their own limit', rejoined.status === 200, rejoined.json);

  const started = await api(token, 'POST', '/api/me/self-exclusion', { duration: '24h' });
  check('a player can start a 24-hour self-exclusion', started.status === 200 && !!started.json.selfExclusion?.until, started.json);

  const blockedExcluded = await api(token, 'POST', '/api/game/join', { roomKey });
  check(
    'self-exclusion blocks joining immediately',
    blockedExcluded.status === 403 && blockedExcluded.json.error?.code === 'SELF_EXCLUDED',
    blockedExcluded.json,
  );

  const ownLift = await api(token, 'POST', `/api/admin/users/${encodeURIComponent(userId)}/limits/lift`, { reason: 'let me back in please' });
  check('a player cannot lift their own exclusion', ownLift.status === 401 || ownLift.status === 403, ownLift.status);

  const badLift = await api(adminToken, 'POST', `/api/admin/users/${encodeURIComponent(userId)}/limits/lift`, { reason: 'no' });
  check('an admin lift without a proper reason is rejected', badLift.status === 400, badLift.json);

  const lifted = await api(adminToken, 'POST', `/api/admin/users/${encodeURIComponent(userId)}/limits/lift`, { reason: 'e2e: verified the lift path' });
  check('an admin can lift it with a logged reason', lifted.status === 200, lifted.json);

  const afterLift = await api(token, 'POST', '/api/game/join', { roomKey });
  check('play resumes only after the admin lift', afterLift.status === 200, afterLift.json);

  const audit = await api(adminToken, 'GET', '/api/admin/audit?action=admin.self_exclusion.lift');
  check(
    'the lift appears in the append-only audit log',
    (audit.json.items ?? []).some((entry: any) => entry.action === 'admin.self_exclusion.lift' && String(entry.metadata).includes('verified the lift path')),
    audit.json.items?.slice(0, 1),
  );

  // Leave the account tidy for the remaining checks.
  await api(token, 'POST', '/api/game/leave', {});
}

section('11 · return to dashboard');
{
  const me = await api(token, 'GET', '/api/me');
  check('player can return to the dashboard with a live balance', typeof me.json.wallet?.balance === 'number', me.json.wallet);
  const logout = await api(token, 'POST', '/api/auth/logout', {});
  check('logout succeeds', logout.status === 200, logout.json);
  const afterLogout = await api(token, 'GET', '/api/me');
  check('the revoked session cannot refresh', afterLogout.status === 401, afterLogout.json);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} · ${step - failures}/${step} checks passed`);
if (failures > 0) process.exitCode = 1;

try {
  ws.close();
} catch {
  /* already closed */
}
await handle.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
