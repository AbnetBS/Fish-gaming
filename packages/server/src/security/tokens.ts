import crypto from 'node:crypto';
import { env } from '../config/env.js';
import type { Role } from '@reef/shared';

/**
 * Access tokens: compact, signed HS256 JWTs implemented directly on
 * `node:crypto` so verification is synchronous (which is what lets every
 * wallet mutation stay inside one atomic SQLite transaction) and so there is
 * no third-party token library in the trust path.
 *
 * Only `sub` (user id) and `sid` (session id) are trusted from the token. Role
 * and account status are always re-read from the database, so suspending an
 * account or changing a role takes effect on the next request even if a token
 * is still inside its validity window.
 */

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'access';
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

const b64u = (buf: Buffer | string): string => Buffer.from(buf as any).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function sign(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function signAccessToken(userId: string, sessionId: string, ttlSeconds?: number): string {
  const e = env();
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(
    JSON.stringify({
      sub: userId,
      sid: sessionId,
      typ: 'access',
      iat: now,
      exp: now + (ttlSeconds ?? e.accessTokenTtlS),
      iss: e.jwtIssuer,
      aud: e.jwtAudience,
    }),
  );
  const body = `${header}.${payload}`;
  return `${body}.${sign(body, e.jwtSecret)}`;
}

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const e = env();
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('Malformed token.');
  const [header, payload, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(`${header}.${payload}`, e.jwtSecret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new TokenError('Invalid token signature.');
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(unb64u(payload).toString('utf8')) as AccessTokenClaims;
  } catch {
    throw new TokenError('Malformed token payload.');
  }
  try {
    const head = JSON.parse(unb64u(header).toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') throw new TokenError('Unsupported algorithm.');
  } catch {
    throw new TokenError('Malformed token header.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + 5 < now) throw new TokenError('Token expired.');
  if (claims.iss !== e.jwtIssuer) throw new TokenError('Invalid token issuer.');
  if (claims.aud !== e.jwtAudience) throw new TokenError('Invalid token audience.');
  if (claims.typ !== 'access') throw new TokenError('Invalid token type.');
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') throw new TokenError('Malformed token claims.');
  return claims;
}

export function roleFromDb(role: Role): Role {
  // Roles always come from the database row; this indirection means a future
  // change to how roles are stored has exactly one edit point.
  return role;
}
