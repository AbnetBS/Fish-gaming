import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { parse } from '../validate.js';
import { requireAuth } from '../auth.js';
import { assertPlayAllowed } from '../../modules/game/limits.js';
import {
  getTournamentDetail,
  joinTournament,
  leaveTournament,
  listPublicTournaments,
  myTournaments,
} from '../../modules/game/tournaments.js';
import { getWallet } from '../../modules/wallet/ledger.js';

/**
 * Player-facing tournament routes: lobby list, entry, standings and history.
 *
 * Joining pays the entry fee into the prize pool; leaving a lobby refunds it.
 * Once the match starts the entry is locked and the arena decides the winner.
 */
export function registerTournamentRoutes(app: FastifyInstance): void {
  app.get('/api/tournaments', async (request) => {
    const user = requireAuth(request);
    return { items: listPublicTournaments(getDb(), user.id) };
  });

  app.get('/api/tournaments/mine', async (request) => {
    const user = requireAuth(request);
    return { items: myTournaments(getDb(), user.id) };
  });

  app.get('/api/tournaments/:id', async (request) => {
    const user = requireAuth(request);
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    return getTournamentDetail(getDb(), params.id, user.id);
  });

  app.post('/api/tournaments/:id/join', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request) => {
    const user = requireAuth(request);
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const db = getDb();
    // Same player-protection gate as room joins: limits and self-exclusion
    // apply to tournaments too.
    assertPlayAllowed(db, user.id);
    const result = joinTournament(db, user.id, params.id);
    return { ...result, wallet: getWallet(db, user.id) };
  });

  app.post('/api/tournaments/:id/leave', async (request) => {
    const user = requireAuth(request);
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const db = getDb();
    const result = leaveTournament(db, user.id, params.id);
    return { ok: true, ...result, wallet: getWallet(db, user.id) };
  });
}
