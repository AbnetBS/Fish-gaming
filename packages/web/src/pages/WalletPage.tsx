import { useCallback, useEffect, useState } from 'react';
import { api, type ProfileDto } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import { usePlatform } from '../state/PlatformContext';
import { useToast } from '../state/toast';
import { Badge, Button, Empty, Panel, Skeleton, Stat, formatCoins, formatSigned, formatDateTime } from '../components/ui';
import type { WalletTransaction } from '@reef/shared';

/**
 * Demo wallet. There is no deposit, no withdrawal and no price anywhere on this
 * screen: "add coins" is a free grant and the page says so.
 */
export function WalletPage(): JSX.Element {
  const { wallet, refreshMe } = useAuth();
  const { meta } = usePlatform();
  const toast = useToast();
  const [transactions, setTransactions] = useState<WalletTransaction[] | null>(null);
  const [totals, setTotals] = useState<{ wagered: number; rewarded: number; rounds: number; net: number } | null>(null);
  const [plans, setPlans] = useState<{ id: string; label: string; demoCoins: number }[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [walletPayload, planPayload] = await Promise.all([api.wallet(), api.plans()]);
      setTotals(walletPayload.totals);
      setPlans(planPayload.plans);
      const txPayload = await api.transactions({ page, limit: 20 });
      setTransactions(txPayload.items);
      setTotal(txPayload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet unavailable.');
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const claim = async (planId: string): Promise<void> => {
    setBusy(planId);
    try {
      const result = await api.demoTopup(planId);
      toast.push(result.credited > 0 ? `+${formatCoins(result.credited)} demo coins added.` : 'Already claimed this hour — try again shortly.', result.credited > 0 ? 'success' : 'info');
      await Promise.all([refreshMe(), load()]);
    } catch (err) {
      toast.push(err instanceof Error ? err.message : 'Could not add demo coins.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / 20));

  return (
    <div style={{ width: 'min(1100px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Demo wallet</h1>
          <p className="sub">A ledger-backed virtual balance. {meta?.legal.demoStatement}</p>
        </div>
        <Badge tone="gold">{meta?.currency.label ?? 'DEMO COINS'}</Badge>
      </div>

      <div className="dash-hero card" style={{ padding: '1.2rem' }}>
        <div className="dash-balance">
          <span className="k upper">Available demo coins</span>
          <span className="v num">{formatCoins(wallet?.balance ?? 0)}</span>
          <span className="tiny dim">Currency code {meta?.currency.code ?? 'DEMO'} · not money · cannot be withdrawn</span>
        </div>
        <div className="dash-stats">
          <Stat label="Total wagered" value={formatCoins(totals?.wagered ?? 0)} tone="cyan" hint="Spent on shots" />
          <Stat label="Total rewarded" value={formatCoins(totals?.rewarded ?? 0)} tone="gold" hint="Won from fish" />
          <Stat label="Net" value={totals ? formatSigned(totals.net) : '—'} tone={(totals?.net ?? 0) >= 0 ? 'green' : 'red'} hint={`${totals?.rounds ?? 0} rounds`} />
        </div>
      </div>

      {error ? <div className="notice-box danger small" style={{ marginBottom: '1rem' }}>{error}</div> : null}

      <Panel title="Add demo coins" className="stack-1">
        <p className="small muted">
          These packs are free. They exist so you can keep playing when your demo balance runs low — nothing is charged, and demo coins
          can never be converted into money or transferred to another account.
        </p>
        <div className="plan-grid">
          {plans.length === 0 ? <Skeleton height={120} /> : null}
          {plans.map((plan) => (
            <article className="plan" key={plan.id}>
              <span className="tiny upper dim">{plan.label}</span>
              <span className="amount num">{formatCoins(plan.demoCoins)}</span>
              <span className="tiny dim">demo coins · price: nothing</span>
              <Button variant="gold" block loading={busy === plan.id} onClick={() => void claim(plan.id)}>
                Claim free pack
              </Button>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="Transaction ledger" pad={false} className="stack-0" >
        {transactions === null ? (
          <div style={{ padding: '1rem' }} className="col"><Skeleton height={30} /><Skeleton height={30} /><Skeleton height={30} /></div>
        ) : transactions.length === 0 ? (
          <Empty title="No transactions yet" body="Every credit, bet, reward and adjustment is recorded here." />
        ) : (
          <>
            <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th className="right">Amount</th>
                    <th className="right">Before</th>
                    <th className="right">After</th>
                    <th>Reference</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td className="tiny dim nowrap">{formatDateTime(tx.createdAt)}</td>
                      <td><span className="tx-type" data-type={tx.type}>{tx.type.replace('_', ' ')}</span></td>
                      <td className={`right num ${tx.amount >= 0 ? 'pos' : 'neg'}`}>{formatSigned(tx.amount)}</td>
                      <td className="right num dim">{formatCoins(tx.balanceBefore)}</td>
                      <td className="right num">{formatCoins(tx.balanceAfter)}</td>
                      <td className="tiny dim num" style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tx.referenceId ?? tx.id}</td>
                      <td className="tiny muted" style={{ maxWidth: 220 }}>{tx.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination" style={{ padding: '0.7rem 1rem' }}>
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Newer</Button>
              <span className="tiny dim">Page {page} of {pages} · {total} rows</span>
              <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Older →</Button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
