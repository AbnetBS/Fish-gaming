import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { env } from '../../config/env.js';
import { REAL_MONEY_ENABLED } from '../../config/flags.js';
import { getActiveConfiguration, isMaintenanceMode } from '../../modules/config/service.js';
import { leaderboard, listRooms } from '../../modules/game/service.js';
import type { RoundManager } from '../../sim/round-manager.js';
import { CURRENCY_LABEL } from '@reef/shared';

/**
 * Public, unauthenticated endpoints: platform meta, the client-safe part of the
 * game configuration, public leaderboard, health.
 *
 * The configuration payload intentionally contains only what a renderer needs
 * (movement, sizes, rewards, costs). Economy values are public by design —
 * they must be auditable — while the admin panel keeps the write path private.
 */
export function registerPublicRoutes(app: FastifyInstance, rounds: () => RoundManager): void {
  app.get('/api/health', async () => {
    const db = getDb();
    return {
      status: 'ok',
      time: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
      db: db.scalar<number>('SELECT 1') === 1 ? 'ok' : 'error',
      maintenance: isMaintenanceMode(db),
    };
  });

  app.get('/api/meta', async () => {
    const db = getDb();
    const config = getActiveConfiguration(db);
    return {
      brand: {
        name: 'Reef Raiders',
        tagline: 'Next-generation underwater arcade gaming.',
      },
      currency: {
        label: CURRENCY_LABEL,
        code: 'DEMO',
        isRealMoney: false,
        startingBalance: env().startingDemoCoins,
      },
      flags: {
        realMoneyEnabled: REAL_MONEY_ENABLED,
        demoMode: !REAL_MONEY_ENABLED,
      },
      legal: {
        demoStatement:
          'This version uses virtual DEMO COINS only. Demo coins have no cash value, cannot be purchased, and cannot be withdrawn or exchanged for money.',
        ageStatement: 'Entertainment product for players 18 and over. This is not a gambling product.',
        realMoneyNotice:
          'Real-money play is disabled and is not offered by this deployment. Any future real-money operation requires its own licensing, age verification, KYC/AML, geographic and responsible-gaming approvals, which cannot be bypassed by configuration.',
      },
      configVersion: config.version,
      maintenance: isMaintenanceMode(db),
      game: {
        width: 1920,
        height: 1080,
        tickMs: env().simTickMs,
        snapshotMs: env().snapshotMs,
      },
    };
  });

  /** Renderer contract: fish/cannon/room values used for visuals + local prediction. */
  app.get('/api/config', async () => {
    const config = getActiveConfiguration(getDb());
    const settings = config.settings;
    return {
      version: config.version,
      settings: {
        maxActiveFish: settings.maxActiveFish,
        fishLifetimeS: settings.fishLifetimeS,
        waveIntervalS: settings.waveIntervalS,
        waveSize: settings.waveSize,
        gameSpeed: settings.gameSpeed,
        minShotValue: settings.minShotValue,
        maxShotValue: settings.maxShotValue,
        specialFishEnabled: settings.specialFishEnabled,
      },
      fish: config.fish
        .filter((f) => f.enabled)
        .map((f) => ({
          key: f.key,
          name: f.name,
          category: f.category,
          health: f.health,
          reward: f.reward,
          speed: f.speed,
          size: f.size,
          rarity: f.rarity,
          movementPattern: f.movementPattern,
          palette: f.palette,
          special: f.special,
        })),
      cannons: config.cannons
        .filter((c) => c.enabled)
        .map((c) => ({ key: c.key, name: c.name, level: c.level, power: c.power, shotCost: c.shotCost, fireRate: c.fireRate, projectileSpeed: c.projectileSpeed })),
      rooms: config.rooms
        .filter((r) => r.status === 'ACTIVE')
        .map((r) => ({ key: r.key, name: r.name, description: r.description, minBet: r.minBet, maxBet: r.maxBet, maxPlayers: r.maxPlayers })),
    };
  });

  app.get('/api/rooms', async () => {
    const db = getDb();
    const manager = rounds();
    return {
      rooms: listRooms(
        db,
        {
          playerCount: (roomId) => manager.roomPlayerCount(roomId),
          roundIdOf: (roomId) => manager.currentRoundId(roomId),
        },
        false,
      ),
      maintenance: isMaintenanceMode(db),
    };
  });

  app.get('/api/leaderboard/:window', async (request) => {
    const params = (request.params ?? {}) as { window?: string };
    const window = (['daily', 'weekly', 'alltime'].includes(params.window ?? '') ? params.window : 'daily') as 'daily' | 'weekly' | 'alltime';
    return { window, items: leaderboard(getDb(), window, 25) };
  });
}
