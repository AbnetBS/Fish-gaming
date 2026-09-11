/**
 * Typed API client.
 *
 * - Same-origin relative URLs only (the dev server proxies `/api` and `/ws`),
 *   so nothing here needs to know the backend host and no secrets are embedded.
 * - The access token lives in memory; a refresh token lives in an httpOnly
 *   cookie, so a page reload silently restores the session.
 * - Every failure is normalised to an `ApiError` with a code + friendly message.
 */

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_FUNDS'
  | 'ROOM_FULL'
  | 'ROOM_UNAVAILABLE'
  | 'MAINTENANCE'
  | 'ACCOUNT_SUSPENDED'
  | 'NO_ACTIVE_SESSION'
  | 'INVALID_SESSION'
  | 'WEAPON_UNAVAILABLE'
  | 'BET_OUT_OF_RANGE'
  | 'GAME_UNAVAILABLE'
  | 'REAL_MONEY_DISABLED'
  | 'NETWORK'
  | 'INTERNAL'
  | (string & {});

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Milliseconds to wait before the action may be retried (rate limited). */
  readonly waitMs?: number;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown, waitMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.waitMs = waitMs;
  }
}

let accessToken: string | null = null;
let csrfToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function setTokens(tokens: { accessToken?: string | null; csrfToken?: string | null } | null): void {
  accessToken = tokens?.accessToken ?? null;
  csrfToken = tokens?.csrfToken ?? null;
  for (const listener of listeners) listener(accessToken);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onTokenChange(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the automatic refresh-and-retry (used by the refresh call itself). */
  noRetry?: boolean;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = path.startsWith('/') ? path : `/${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the game server. Check your connection.', undefined, undefined);
  }
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (csrfToken && options.method && options.method !== 'GET') headers['x-csrf-token'] = csrfToken;

  const response = await rawFetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 401 && !options.noRetry && accessToken) {
    const refreshed = await tryRefresh();
    if (refreshed) return apiFetch<T>(path, { ...options, noRetry: true });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 200) };
    }
  }

  if (!response.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(
      response.status,
      err.code ?? 'INTERNAL',
      friendlyMessage(response.status, err.code, err.message),
      err.details,
      err.waitMs,
    );
  }
  if (payload?.accessToken) setTokens({ accessToken: payload.accessToken, csrfToken: payload.csrfToken ?? csrfToken });
  return payload as T;
}

/** Attempts a single token refresh; concurrent callers share one request. */
export function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await rawFetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        accessToken = null;
        csrfToken = null;
        for (const listener of listeners) listener(null);
        return false;
      }
      const data = (await response.json()) as { accessToken?: string; csrfToken?: string };
      if (!data.accessToken) return false;
      setTokens({ accessToken: data.accessToken, csrfToken: data.csrfToken ?? null });
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

function friendlyMessage(status: number, code: string | undefined, serverMessage?: string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'Not enough demo coins.';
    case 'ROOM_FULL':
      return 'Room is full. Try another room.';
    case 'ROOM_UNAVAILABLE':
    case 'GAME_UNAVAILABLE':
      return 'Game unavailable right now. Please try again shortly.';
    case 'MAINTENANCE':
      return 'The game is under maintenance. Please check back soon.';
    case 'RATE_LIMITED':
      return 'You are doing that too quickly. Please wait a moment.';
    case 'ACCOUNT_SUSPENDED':
      return 'This account is suspended. Please contact support.';
    case 'INVALID_SESSION':
    case 'NO_ACTIVE_SESSION':
      return 'Your game session ended. Please rejoin the room.';
    case 'BET_OUT_OF_RANGE':
      return serverMessage ?? 'That bet is not allowed in this room.';
    case 'WEAPON_UNAVAILABLE':
      return 'That cannon is not available here.';
    case 'REAL_MONEY_DISABLED':
      return 'This platform runs on virtual demo coins only.';
    case 'UNAUTHENTICATED':
      return status === 401 ? 'Please sign in to continue.' : (serverMessage ?? 'Not authorised.');
    case 'VALIDATION_FAILED':
      return serverMessage ?? 'Please check the highlighted fields.';
    default:
      if (status === 0) return 'Connection lost. Reconnecting...';
      return serverMessage ?? 'Something went wrong on our side. Please try again.';
  }
}

/* -------------------------------- endpoints -------------------------------- */

import type {
  AdminStats,
  AuditEntry,
  CannonConfig,
  FishConfig,
  GameConfiguration,
  GameHistoryEntry,
  LeaderboardEntry,
  LeaderboardWindow,
  PublicUser,
  RoomSummary,
  Wallet,
  WalletTransaction,
} from '@reef/shared';

export interface ProfileDto {
  displayName: string | null;
  country: string | null;
  bio: string | null;
  language: string;
  loginNotify: boolean;
  sessionLimitMin: number | null;
}

export type SelfExclusionDuration = '24h' | '7d' | '30d' | '90d';

/** Mirrors the server's enforcement view: what the limit is and how much is used. */
export interface PlayLimits {
  limitMin: number;
  minutesPlayedToday: number;
  /** null = unlimited */
  minutesRemaining: number | null;
  selfExcludedUntil?: string | null;
}

export interface AuthPayload {
  user: PublicUser;
  profile: ProfileDto;
  wallet: Wallet;
  accessToken: string;
  refreshToken?: string;
  /** Set when the player's own "new sign-in alerts" setting flagged this login. */
  securityNotice?: string | null;
  csrfToken?: string;
}

export interface RoomListPayload {
  rooms: RoomSummary[];
  maintenance: boolean;
}

export interface BetOption {
  key: string;
  name: string;
  level: number;
  power: number;
  shotCost: number;
  fireRate: number;
  legal: boolean;
  reason?: string;
}

export interface JoinPayload {
  roomId: string;
  roomKey: string;
  roundId: string;
  sessionId: string;
  wallet: Wallet;
  cannonKey: string;
  betOptions: BetOption[];
  /** Player-protection budget the game screen mirrors. */
  limits?: { limitMin: number; minutesPlayedToday: number; minutesRemaining: number | null };
}

export interface SessionSummary {
  sessionId: string;
  roundId: string;
  roomId: string;
  roomName: string;
  configVersion: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  shots: number;
  wagered: number;
  rewarded: number;
  net: number;
  kills: number;
}

export interface MetaPayload {
  brand: { name: string; tagline: string };
  currency: { label: string; code: string; isRealMoney: boolean; startingBalance: number };
  flags: { realMoneyEnabled: boolean; demoMode: boolean };
  legal: { demoStatement: string; ageStatement: string; realMoneyNotice: string };
  configVersion: string;
  maintenance: boolean;
  game: { width: number; height: number; tickMs: number; snapshotMs: number };
}

export interface ClientConfig {
  version: string;
  settings: {
    maxActiveFish: number;
    fishLifetimeS: number;
    waveIntervalS: number;
    waveSize: number;
    gameSpeed: number;
    minShotValue: number;
    maxShotValue: number;
    specialFishEnabled: boolean;
  };
  fish: FishConfig[];
  cannons: CannonConfig[];
  rooms: RoomSummary[];
}

export const api = {
  meta: () => apiFetch<MetaPayload>('/api/meta'),
  config: () => apiFetch<ClientConfig>('/api/config'),
  health: () => apiFetch<{ status: string; maintenance: boolean }>('/api/health'),

  register: (input: { username: string; email: string; password: string; acceptTerms: boolean }) =>
    apiFetch<AuthPayload>('/api/auth/register', { method: 'POST', body: input }),
  login: (identifier: string, password: string) =>
    apiFetch<AuthPayload>('/api/auth/login', { method: 'POST', body: { identifier, password } }),
  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: {} }),
  me: () =>
    apiFetch<{
      user: PublicUser;
      profile: ProfileDto;
      wallet: Wallet;
      permissions: string[];
      totals: { wagered: number; rewarded: number; rounds: number; net: number };
    }>('/api/me'),
  updateProfile: (patch: Partial<ProfileDto>) => apiFetch<{ profile: ProfileDto }>('/api/me/profile', { method: 'PATCH', body: patch }),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<{ ok: boolean; message: string }>('/api/me/password', { method: 'POST', body: { currentPassword, newPassword } }),
  forgotPassword: (email: string) => apiFetch<{ ok: boolean; message: string; devResetToken?: string }>('/api/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token: string, password: string) => apiFetch<{ ok: boolean; message: string }>('/api/auth/reset-password', { method: 'POST', body: { token, password } }),
  verifyEmail: (token: string) => apiFetch<{ ok: boolean; message: string }>('/api/auth/verify-email', { method: 'POST', body: { token } }),
  sessions: () => apiFetch<{ items: { id: string; ip: string | null; userAgent: string | null; createdAt: string; expiresAt: string }[] }>('/api/auth/sessions'),
  revokeAllSessions: () => apiFetch<{ ok: boolean; message: string }>('/api/auth/sessions/revoke-all', { method: 'POST', body: {} }),

  /* --------------------------- player protection --------------------------- */
  playLimits: () =>
    apiFetch<PlayLimits>('/api/me/limits'),
  startSelfExclusion: (duration: SelfExclusionDuration) =>
    apiFetch<{ ok: boolean; selfExclusion: { until: string; duration: SelfExclusionDuration } }>('/api/me/self-exclusion', {
      method: 'POST',
      body: { duration },
    }),

  wallet: () => apiFetch<{ wallet: Wallet; totals: { wagered: number; rewarded: number; rounds: number; net: number } }>('/api/wallet'),
  transactions: (params: { page?: number; limit?: number; type?: string }) =>
    apiFetch<{ items: WalletTransaction[]; total: number; page: number; pageSize: number }>('/api/wallet/transactions', { query: params }),

  rooms: () => apiFetch<RoomListPayload>('/api/game/rooms'),
  join: (roomKey: string, cannonKey?: string) => apiFetch<JoinPayload>('/api/game/join', { method: 'POST', body: { roomKey, cannonKey } }),
  leave: () => apiFetch<{ ok: boolean; summary: unknown; wallet: Wallet }>('/api/game/leave', { method: 'POST', body: {} }),
  gameSession: () => apiFetch<{ session: unknown; betOptions: BetOption[]; wallet: Wallet; snapshot: unknown } | { session: null }>('/api/game/session'),
  status: () => apiFetch<{ serverTime: number; tickMs: number; snapshotMs: number; online: number; maintenance: boolean; rooms: unknown[] }>('/api/game/status'),
  history: (params: { page?: number; limit?: number; roomId?: string }) =>
    apiFetch<{ items: GameHistoryEntry[]; total: number; page: number; pageSize: number }>('/api/history', { query: params }),
  gameSessions: () => apiFetch<{ items: SessionSummary[] }>('/api/sessions'),
  leaderboard: (window: LeaderboardWindow, limit = 20) =>
    apiFetch<{ window: LeaderboardWindow; items: LeaderboardEntry[]; me: { rank: number | null; earned: number } | null }>(`/api/leaderboard/${window}`),

  plans: () => apiFetch<{ plans: { id: string; label: string; demoCoins: number; price: null }[] }>('/api/payments/plans'),
  demoTopup: (planId: string) => apiFetch<{ ok: boolean; credited: number; wallet: Wallet }>('/api/payments/demo-topup', { method: 'POST', body: { planId } }),

  admin: {
    dashboard: () => apiFetch<AdminStats & { configuration: { version: string; isDraftAhead: boolean; publishedAt: string }; ledgerIntegrity: { checked: number; mismatches: string[] } }>('/api/admin/dashboard'),
    users: (params: { search?: string; status?: string; page?: number; limit?: number }) =>
      apiFetch<{ items: any[]; total: number; page: number; pageSize: number }>('/api/admin/users', { query: params }),
    user: (id: string) => apiFetch<any>(`/api/admin/users/${encodeURIComponent(id)}`),
    setUserStatus: (id: string, status: string, reason: string) =>
      apiFetch<{ ok: boolean; user: PublicUser }>(`/api/admin/users/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status, reason } }),
    adjustDemoCoins: (id: string, amount: number, reason: string) =>
      apiFetch<{ ok: boolean; balance: number }>(`/api/admin/users/${encodeURIComponent(id)}/demo-coins`, { method: 'POST', body: { amount, reason } }),
    userLimits: (id: string) => apiFetch<PlayLimits>(`/api/admin/users/${encodeURIComponent(id)}/limits`),
    liftSelfExclusion: (id: string, reason: string) =>
      apiFetch<{ ok: boolean; profile: ProfileDto }>(`/api/admin/users/${encodeURIComponent(id)}/limits/lift`, { method: 'POST', body: { reason } }),

    fish: () => apiFetch<{ items: FishConfig[] }>('/api/admin/fish'),
    createFish: (body: Partial<FishConfig> & { key: string; name: string }) => apiFetch<{ fish: FishConfig }>('/api/admin/fish', { method: 'POST', body }),
    updateFish: (id: string, body: Partial<FishConfig>) => apiFetch<{ ok: boolean; fish: FishConfig; changed: Record<string, unknown> }>(`/api/admin/fish/${id}`, { method: 'PATCH', body }),
    deleteFish: (id: string) => apiFetch<{ ok: boolean }>(`/api/admin/fish/${id}`, { method: 'DELETE' }),

    cannons: () => apiFetch<{ items: CannonConfig[] }>('/api/admin/cannons'),
    createCannon: (body: Partial<CannonConfig> & { key: string; name: string }) => apiFetch<{ cannon: CannonConfig }>('/api/admin/cannons', { method: 'POST', body }),
    updateCannon: (id: string, body: Partial<CannonConfig>) => apiFetch<{ ok: boolean; cannon: CannonConfig }>(`/api/admin/cannons/${id}`, { method: 'PATCH', body }),

    rooms: () => apiFetch<{ items: (RoomSummary & { activeRounds: number; sessionsToday: number })[] }>('/api/admin/rooms'),
    createRoom: (body: Record<string, unknown>) => apiFetch<{ room: RoomSummary }>('/api/admin/rooms', { method: 'POST', body }),
    updateRoom: (id: string, body: Record<string, unknown>) => apiFetch<{ ok: boolean; room: RoomSummary }>(`/api/admin/rooms/${id}`, { method: 'PATCH', body }),

    settings: () => apiFetch<{ settings: GameConfiguration['settings']; system: { key: string; value: string }[]; meta: { version: string; isDraftAhead: boolean } }>('/api/admin/settings'),
    updateSettings: (body: Partial<GameConfiguration['settings']>) => apiFetch<{ ok: boolean; settings: GameConfiguration['settings'] }>('/api/admin/settings', { method: 'PATCH', body }),
    versions: () => apiFetch<{ items: { version: string; notes: string | null; active: boolean; publishedAt: string; publishedBy: string | null }[] }>('/api/admin/config/versions'),
    version: (version: string) => apiFetch<{ version: string; publishedAt: string; notes: string | null; config: GameConfiguration }>(`/api/admin/config/versions/${encodeURIComponent(version)}`),
    publish: (notes?: string) => apiFetch<{ ok: boolean; version: string; meta: { version: string; isDraftAhead: boolean } }>('/api/admin/config/publish', { method: 'POST', body: { notes } }),

    history: (params: { page?: number; limit?: number; result?: string; roomId?: string }) => apiFetch<{ items: any[]; total: number }>('/api/admin/history', { query: params }),
    rounds: (params: { limit?: number; roomId?: string }) => apiFetch<{ items: any[]; total: number }>('/api/admin/rounds', { query: params }),
    roundAudit: (roundId: string) => apiFetch<any>(`/api/admin/rounds/${encodeURIComponent(roundId)}/audit`),
    transactions: (params: { page?: number; limit?: number; type?: string }) => apiFetch<{ items: any[]; total: number; integrity: { checked: number; mismatches: string[] } }>('/api/admin/transactions', { query: params }),
    overview: () => apiFetch<{ demo: AdminStats; liveRooms: any[]; disclaimer: string }>('/api/admin/reports/overview'),
    audit: (params: { page?: number; limit?: number; entity?: string; action?: string }) => apiFetch<{ items: AuditEntry[]; total: number; page: number }>('/api/admin/audit', { query: params }),
    setMaintenance: (enabled: boolean, reason?: string) => apiFetch<{ ok: boolean; maintenance: boolean }>('/api/admin/maintenance', { method: 'POST', body: { enabled, reason } }),
    exportUrl: (kind: 'rounds' | 'history' | 'transactions') => `/api/admin/reports/export.csv?kind=${kind}`,
  },
};
