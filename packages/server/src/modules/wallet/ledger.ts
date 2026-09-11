import type { Database } from '../../db/index.js';
import { AppError, insufficientFunds } from '../../lib/errors.js';
import { uid } from '../../lib/ids.js';
import type { TransactionType, Wallet, WalletTransaction } from '@reef/shared';

/**
 * ---------------------------------------------------------------------------
 * DEMO WALLET LEDGER
 * ---------------------------------------------------------------------------
 *
 * The wallet balance is a *derived* value produced by this service and nothing
 * else. There is no public route that says "set my balance to N". Rules:
 *
 *  1. Every mutation happens inside a single IMMEDIATE SQLite transaction, so
 *     reading the balance and writing it back cannot interleave with another
 *     request (no double-spend under concurrency).
 *  2. `wallets.balance >= 0` is a database CHECK constraint — the engine itself
 *     refuses a negative balance even if application logic is wrong.
 *  3. Each mutation writes exactly one `wallet_transactions` row carrying
 *     `balance_before`, `balance_after`, and `CHECK (after = before + amount)`.
 *     The ledger and the balance can therefore be reconciled at any time.
 *  4. Callers must supply an `idempotencyKey` for anything that can be retried.
 *     The unique index on that key makes replays a no-op that returns the
 *     original transaction instead of crediting twice.
 *  5. Amounts are whole DEMO COINS (integers) — never floats, never currency.
 */

export interface LedgerEntryInput {
  userId: string;
  type: TransactionType;
  /** Signed amount in DEMO COINS. */
  amount: number;
  referenceId?: string | null;
  gameRoundId?: string | null;
  idempotencyKey?: string | null;
  description?: string | null;
}

export interface LedgerResult {
  transaction: WalletTransaction;
  wallet: Wallet;
  /** True when the call matched a previously recorded transaction. */
  replayed: boolean;
}

interface WalletRow {
  id: string;
  user_id: string;
  balance: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

function toWallet(r: WalletRow): Wallet {
  return {
    id: r.id,
    userId: r.user_id,
    balance: r.balance,
    currency: 'DEMO',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function mapTransaction(r: any): WalletTransaction {
  return {
    id: r.id,
    userId: r.user_id,
    walletId: r.wallet_id,
    type: r.type,
    amount: r.amount,
    balanceBefore: r.balance_before,
    balanceAfter: r.balance_after,
    referenceId: r.reference_id,
    gameRoundId: r.game_round_id,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    description: r.description,
    createdAt: r.created_at,
  };
}

export function ensureWallet(db: Database, userId: string, openingBalance = 0): Wallet {
  const existing = db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', userId);
  if (existing) return toWallet(existing);
  const timestamp = new Date().toISOString();
  const id = uid('wlt');
  db.run(
    `INSERT INTO wallets (id, user_id, balance, currency, version, created_at, updated_at) VALUES (?,?,?,?,0,?,?)`,
    id,
    userId,
    openingBalance,
    'DEMO',
    timestamp,
    timestamp,
  );
  if (openingBalance > 0) {
    recordLedgerEntry(db, {
      userId,
      type: 'DEMO_CREDIT',
      amount: openingBalance,
      description: 'Welcome demo credit',
      idempotencyKey: `signup-credit:${userId}`,
    });
  }
  return toWallet(db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', userId)!);
}

/**
 * Append a signed amount to the ledger and update the balance atomically.
 * Never call this with a client-supplied `amount` for a WIN — amounts must be
 * derived from server-side game state.
 */
export function recordLedgerEntry(db: Database, input: LedgerEntryInput): LedgerResult {
  if (!Number.isInteger(input.amount)) {
    throw new AppError(500, 'INTERNAL', 'Ledger amounts must be integers.');
  }
  if (input.amount === 0) {
    throw new AppError(500, 'INTERNAL', 'Zero-amount ledger entries are not allowed.');
  }

  return db.transaction(() => {
    // Replays short-circuit inside the same transaction as the guard below.
    if (input.idempotencyKey) {
      const prior = db.get<any>(
        'SELECT * FROM wallet_transactions WHERE idempotency_key = ? LIMIT 1',
        input.idempotencyKey,
      );
      if (prior) {
        const wallet = db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', input.userId);
        if (!wallet) throw new AppError(500, 'INTERNAL', 'Wallet missing.');
        return { transaction: mapTransaction(prior), wallet: toWallet(wallet), replayed: true };
      }
    }

    const wallet = db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', input.userId);
    if (!wallet) throw new AppError(500, 'INTERNAL', 'Wallet missing.');

    const before = wallet.balance;
    const after = before + input.amount;
    if (after < 0) {
      throw insufficientFunds('Not enough demo coins.');
    }

    const timestamp = new Date().toISOString();
    const txId = uid('tx');
    db.run(
      `INSERT INTO wallet_transactions
         (id, user_id, wallet_id, type, amount, balance_before, balance_after, reference_id, game_round_id, idempotency_key, status, description, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'COMPLETED',?,?)`,
      txId,
      input.userId,
      wallet.id,
      input.type,
      input.amount,
      before,
      after,
      input.referenceId ?? null,
      input.gameRoundId ?? null,
      input.idempotencyKey ?? null,
      input.description ?? null,
      timestamp,
    );
    db.run('UPDATE wallets SET balance = ?, version = version + 1, updated_at = ? WHERE id = ?', after, timestamp, wallet.id);

    return {
      transaction: mapTransaction(db.get<any>('SELECT * FROM wallet_transactions WHERE id = ?', txId)!),
      wallet: { ...toWallet(wallet), balance: after, updatedAt: timestamp },
      replayed: false,
    };
  });
}

/** Reserve coins for a shot. Convenience wrapper over a negative BET entry. */
export function debit(
  db: Database,
  input: { userId: string; amount: number; referenceId: string; gameRoundId: string; description: string },
): LedgerResult {
  if (input.amount <= 0) throw new AppError(500, 'INTERNAL', 'Debit amount must be positive.');
  return recordLedgerEntry(db, {
    userId: input.userId,
    type: 'BET',
    amount: -input.amount,
    referenceId: input.referenceId,
    gameRoundId: input.gameRoundId,
    // Deterministic key: the same shot can never be charged twice, even if the
    // client retries after a dropped connection.
    idempotencyKey: `bet:${input.referenceId}`,
    description: input.description,
  });
}

export function credit(
  db: Database,
  input: {
    userId: string;
    amount: number;
    type?: TransactionType;
    referenceId: string;
    gameRoundId?: string | null;
    idempotencyKey?: string | null;
    description?: string;
  },
): LedgerResult {
  return recordLedgerEntry(db, {
    userId: input.userId,
    type: input.type ?? 'WIN',
    amount: input.amount,
    referenceId: input.referenceId,
    gameRoundId: input.gameRoundId ?? null,
    idempotencyKey: input.idempotencyKey ?? `win:${input.referenceId}`,
    description: input.description ?? null,
  });
}

export function getWallet(db: Database, userId: string): Wallet {
  const row = db.get<WalletRow>('SELECT * FROM wallets WHERE user_id = ?', userId);
  if (!row) throw new AppError(500, 'INTERNAL', 'Wallet missing.');
  return toWallet(row);
}

export function listTransactions(
  db: Database,
  userId: string,
  params: { limit?: number; offset?: number; type?: TransactionType },
): { items: WalletTransaction[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const args: unknown[] = [userId];
  let clause = 'WHERE user_id = ?';
  if (params.type) {
    clause += ' AND type = ?';
    args.push(params.type);
  }
  const total = db.scalar<number>(`SELECT COUNT(*) FROM wallet_transactions ${clause}`, ...args) ?? 0;
  const items = db
    .all<any>(
      `SELECT * FROM wallet_transactions ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    )
    .map(mapTransaction);
  return { items, total };
}

/** Reconciliation helper used by the admin reports screen and the test suite. */
export function verifyLedgerIntegrity(db: Database): { checked: number; mismatches: string[] } {
  const wallets = db.all<{ id: string; user_id: string; balance: number }>('SELECT id, user_id, balance FROM wallets');
  const mismatches: string[] = [];
  for (const w of wallets) {
    const sum =
      db.scalar<number>(
        "SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE wallet_id = ? AND status = 'COMPLETED'",
        w.id,
      ) ?? 0;
    if (sum !== w.balance) mismatches.push(`${w.user_id}: balance=${w.balance} ledgerSum=${sum}`);
  }
  return { checked: wallets.length, mismatches };
}
