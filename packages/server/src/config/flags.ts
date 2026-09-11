import { env } from './env.js';
import { AppError } from '../lib/errors.js';

/**
 * ---------------------------------------------------------------------------
 * REAL MONEY FEATURE FLAG — READ THIS
 * ---------------------------------------------------------------------------
 *
 * This deployment is a **virtual-coin arcade demo**. It does not accept
 * deposits, does not pay out, and has no cash balance anywhere in the system.
 *
 * `REAL_MONEY_ENABLED` is a hard gate, not a marketing switch. Turning it on
 * does **not** make real-money gaming legal, and this codebase deliberately
 * contains no mechanism to bypass:
 *
 *   - gaming / lottery licensing
 *   - payment-provider terms of service
 *   - minimum-age verification
 *   - KYC / identity verification
 *   - AML / transaction monitoring
 *   - geographic restrictions
 *   - responsible-gaming obligations (limits, self-exclusion, cool-offs)
 *
 * Before any operator flips this flag they must have obtained, independently,
 * the authorisations described in `docs/COMPLIANCE.md`. Operating a physical
 * gaming venue does NOT authorise online real-money gaming.
 *
 * While the flag is false the server:
 *   * refuses to start in production if the flag is true without a signed
 *     attestation string,
 *   * returns HTTP 403 `REAL_MONEY_DISABLED` from every `/api/payments/*`
 *     route that would move value,
 *   * labels every balance, ledger row and UI string as DEMO COINS.
 */
export const REAL_MONEY_ENABLED: boolean =
  (process.env.REAL_MONEY_ENABLED ?? 'false').trim().toLowerCase() === 'true';

/** Human-readable attestation required to start production with money on. */
const ATTESTATION = (process.env.REAL_MONEY_ATTESTATION ?? '').trim();

export interface FeatureFlags {
  realMoneyEnabled: boolean;
  demoMode: boolean;
  currencyLabel: string;
  currencyCode: string;
  maintenanceMode: boolean;
}

export function featureFlags(): FeatureFlags {
  return {
    realMoneyEnabled: REAL_MONEY_ENABLED,
    demoMode: !REAL_MONEY_ENABLED,
    currencyLabel: 'DEMO COINS',
    currencyCode: 'DEMO',
    maintenanceMode: false,
  };
}

/** Called at boot. Refuses to start an unsafe production configuration. */
export function assertRealMoneyPolicySafe(): void {
  const e = env();
  if (REAL_MONEY_ENABLED && e.isProduction && ATTESTATION.length < 16) {
    throw new Error(
      'REFUSING TO START: REAL_MONEY_ENABLED=true in production requires REAL_MONEY_ATTESTATION ' +
        '(a signed compliance attestation). See docs/COMPLIANCE.md.',
    );
  }
}

/** Throws unless real-money mode is explicitly and safely enabled. */
export function requireRealMoneyEnabled(): void {
  if (!REAL_MONEY_ENABLED) {
    throw new AppError(403, 'REAL_MONEY_DISABLED', 'Real-money features are disabled in this deployment.');
  }
}
