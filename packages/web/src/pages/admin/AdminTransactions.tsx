import { useState } from 'react';
import { api } from '../../lib/api';
import { AdminState, useResource } from './shared';
import { Badge, Button, Panel, formatCoins, formatDateTime, formatSigned } from '../../components/ui';

export function AdminTransactions(): JSX.Element {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const resource = useResource(() => api.admin.transactions({ page, limit: 50, type: type || undefined }), [page, type]);
  const rows = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const integrity = resource.data?.integrity;

  return (
    <div className="col stack-2">
      <div className="notice-box info small">
        <strong>Demo ledger.</strong> These are virtual demo-coin movements: welcome credits, bets, rewards and operator adjustments. No
        row on this screen represents money, and none can be reversed into money.
      </div>

      <Panel title={`Transaction ledger · ${formatCoins(total)} entries`}>
        <div className="row wrap" style={{ marginBottom: '0.8rem', gap: '0.5rem' }}>
          <select className="select" style={{ maxWidth: 220 }} value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}>
            <option value="">All types</option>
            <option value="DEMO_CREDIT">DEMO_CREDIT</option>
            <option value="BET">BET</option>
            <option value="WIN">WIN</option>
            <option value="REFUND">REFUND</option>
            <option value="ADMIN_ADJUSTMENT">ADMIN_ADJUSTMENT</option>
          </select>
          <div className="grow" />
          {integrity ? (
            integrity.mismatches.length ? <Badge tone="red">{integrity.mismatches.length} reconciliation mismatch</Badge> : <Badge tone="green">{integrity.checked} wallets reconcile exactly</Badge>
          ) : null}
          <a className="btn btn-ghost btn-sm" href={api.admin.exportUrl('transactions')}>Download CSV</a>
        </div>
        <AdminState error={resource.error} loading={resource.loading} empty={!rows.length}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Player</th><th>Type</th><th className="right">Amount</th><th className="right">Before</th><th className="right">After</th><th>Round</th><th>Status</th><th>Note</th></tr>
              </thead>
              <tbody>
                {rows.map((row: any) => (
                  <tr key={row.id}>
                    <td className="tiny dim nowrap">{formatDateTime(row.createdAt)}</td>
                    <td><strong>{row.username}</strong></td>
                    <td><span className="tx-type" data-type={row.type}>{row.type.replace('_', ' ')}</span></td>
                    <td className={`right num ${row.amount >= 0 ? 'pos' : 'neg'}`}>{formatSigned(row.amount)}</td>
                    <td className="right num dim">{formatCoins(row.balanceBefore)}</td>
                    <td className="right num">{formatCoins(row.balanceAfter)}</td>
                    <td className="tiny dim num">{row.roundId ?? '—'}</td>
                    <td><Badge tone={row.status === 'COMPLETED' ? 'green' : 'gold'}>{row.status}</Badge></td>
                    <td className="tiny muted" style={{ maxWidth: 240 }}>{row.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</Button>
            <span className="tiny dim">Page {page} of {pages}</span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>→</Button>
          </div>
        </AdminState>
      </Panel>
    </div>
  );
}
