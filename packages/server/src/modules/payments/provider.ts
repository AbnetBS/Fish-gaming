import { requireRealMoneyEnabled } from '../../config/flags.js';
import { AppError, badRequest } from '../../lib/errors.js';

/**
 * ---------------------------------------------------------------------------
 * PAYMENT PROVIDER ABSTRACTION
 * ---------------------------------------------------------------------------
 *
 * This is the seam a future, properly licensed real-money deployment plugs
 * into. It is intentionally an *interface plus a demo implementation*: there is
 * no HTTP route in this codebase that moves real value, no card/PSP
 * integration, and no withdrawal execution path.
 *
 * A production provider must guarantee:
 *  - `verifyDeposit` is only ever satisfied by a webhook signature the provider
 *    itself can prove (HMAC / RSA), checked against the raw request body, and
 *    only then is the wallet credited — the client can never confirm a payment.
 *  - `verifyWithdrawal` executes after AML/age/geo/responsible-gaming checks
 *    return green, and is idempotent on `idempotencyKey`.
 *  - Amounts are canonical integers in the provider's minor units and are
 *    re-read from the provider, never trusted from our own request payload.
 *  - Every state transition writes `wallet_transactions` + `audit_logs`.
 */

export type DepositStatus = 'CREATED' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type WithdrawalStatus = 'REQUESTED' | 'PENDING_REVIEW' | 'APPROVED' | 'PAID' | 'REJECTED' | 'FAILED';

export interface DepositIntent {
  userId: string;
  /** Minor units (e.g. cents). Never used for demo coins. */
  amount: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export interface DepositRecord extends DepositIntent {
  providerId: string;
  status: DepositStatus;
  verifiedAt: string | null;
  creditedTransactionId: string | null;
  createdAt: string;
}

export interface WithdrawalIntent {
  userId: string;
  amount: number;
  currency: string;
  destinationRef: string;
  idempotencyKey: string;
}

export interface WithdrawalRecord extends WithdrawalIntent {
  providerId: string;
  status: WithdrawalStatus;
  reviewedBy: string | null;
  createdAt: string;
}

export interface WebhookContext {
  rawBody: string;
  headers: Record<string, string>;
}

export interface PaymentProvider {
  readonly id: string;
  /** True when this provider can move real value. Demo is always false. */
  readonly settlesRealMoney: boolean;
  createDeposit(intent: DepositIntent): Promise<DepositRecord>;
  verifyDeposit(recordId: string, ctx: WebhookContext): Promise<DepositRecord>;
  createWithdrawal(intent: WithdrawalIntent): Promise<WithdrawalRecord>;
  verifyWithdrawal(recordId: string, ctx: WebhookContext): Promise<WithdrawalRecord>;
  handleWebhook(ctx: WebhookContext): Promise<{ acknowledged: true; eventId: string }>;
}

/**
 * Development-only provider. Grants *virtual* demo coins on a "top up" and
 * never transfers anything of value. Withdrawals are rejected by design.
 */
export class DemoPaymentProvider implements PaymentProvider {
  readonly id = 'demo';
  readonly settlesRealMoney = false;

  createDeposit(_intent: DepositIntent): Promise<DepositRecord> {
    return Promise.reject(
      new AppError(403, 'REAL_MONEY_DISABLED', 'Deposits are disabled. This platform runs on virtual demo coins only.'),
    );
  }

  verifyDeposit(_recordId: string, _ctx: WebhookContext): Promise<DepositRecord> {
    return Promise.reject(new AppError(403, 'REAL_MONEY_DISABLED', 'Payment verification is disabled.'));
  }

  createWithdrawal(_intent: WithdrawalIntent): Promise<WithdrawalRecord> {
    return Promise.reject(
      new AppError(403, 'REAL_MONEY_DISABLED', 'Withdrawals are disabled. Demo coins have no cash value.'),
    );
  }

  verifyWithdrawal(_recordId: string, _ctx: WebhookContext): Promise<WithdrawalRecord> {
    return Promise.reject(new AppError(403, 'REAL_MONEY_DISABLED', 'Payment verification is disabled.'));
  }

  handleWebhook(ctx: WebhookContext): Promise<{ acknowledged: true; eventId: string }> {
    requireRealMoneyEnabled();
    if (!ctx.rawBody) throw badRequest('Empty webhook body.');
    throw new AppError(403, 'REAL_MONEY_DISABLED', 'No payment provider is configured for this deployment.');
  }
}

/** Registry so a licensed deployment can register its own provider. */
const providers = new Map<string, PaymentProvider>();
let activeId = 'demo';

export function registerPaymentProvider(provider: PaymentProvider, makeActive = false): void {
  providers.set(provider.id, provider);
  if (makeActive) activeId = provider.id;
}

export function getPaymentProvider(id = activeId): PaymentProvider {
  const provider = providers.get(id);
  if (!provider) throw new AppError(500, 'INTERNAL', 'Payment provider is not configured.');
  // Belt and braces: even if someone registers a real provider, it cannot be
  // used while the feature flag is off.
  if (provider.settlesRealMoney) requireRealMoneyEnabled();
  return provider;
}

registerPaymentProvider(new DemoPaymentProvider(), true);

export interface TopUpPlan {
  id: string;
  label: string;
  demoCoins: number;
  price: null;
}

/**
 * "Buy more demo coins" is a free grant, clearly labelled as such. There is no
 * price, no checkout, and no path from money to coins in either direction.
 */
export const DEMO_TOPUP_PLANS: TopUpPlan[] = [
  { id: 'small', label: 'Reef Stash', demoCoins: 5_000, price: null },
  { id: 'medium', label: 'Deep Stash', demoCoins: 20_000, price: null },
  { id: 'large', label: 'Abyss Stash', demoCoins: 100_000, price: null },
];
