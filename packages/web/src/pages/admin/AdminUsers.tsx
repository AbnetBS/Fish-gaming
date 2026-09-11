import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useToast } from '../../state/toast';
import { AdminState, useResource } from './shared';
import { Avatar, Badge, Button, Field, Modal, Panel, formatCoins, formatDateTime, timeAgo } from '../../components/ui';

/**
 * Player-protection readout for support staff. The numbers are the same ones the
 * shot path enforces, and lifting an exclusion is a deliberate, audited action.
 */
function PlayerProtection({
  userId,
  limits,
  onChanged,
}: {
  userId: string;
  limits: { limitMin: number; minutesPlayedToday: number; minutesRemaining: number | null; selfExcludedUntil?: string | null } | null | undefined;
  onChanged: () => void;
}): JSX.Element | null {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!limits) return null;

  const lift = async (): Promise<void> => {
    const reason = window.prompt('Why is this self-exclusion being lifted? Required, and written to the audit log.');
    if (!reason || reason.trim().length < 5) {
      toast.push('A reason of at least 5 characters is required.', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.admin.liftSelfExclusion(userId, reason.trim());
      toast.push('Self-exclusion lifted. Recorded in the audit log.', 'success');
      onChanged();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not lift that exclusion.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Player protection">
      <div className="row wrap" style={{ gap: '1rem', alignItems: 'center' }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="tiny dim">Daily play limit</span>
          <strong className="small">
            {limits.limitMin > 0 ? `${limits.minutesPlayedToday} of ${limits.limitMin} min used today` : 'Not set'}
          </strong>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="tiny dim">Self-exclusion</span>
          <strong className="small" style={{ color: limits.selfExcludedUntil ? 'var(--coral)' : undefined }}>
            {limits.selfExcludedUntil ? `Active until ${formatDateTime(limits.selfExcludedUntil)}` : 'None'}
          </strong>
        </div>
        <div className="grow" />
        {limits.selfExcludedUntil ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void lift()}>
            Lift exclusion
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}

export function AdminUsers(): JSX.Element {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<string | null>(null);
  const [adjustFor, setAdjustFor] = useState<{ id: string; username: string } | null>(null);
  const toast = useToast();

  const resource = useResource(
    () => api.admin.users({ search: search || undefined, status: status || undefined, page, limit: 20 }),
    [search, status, page],
  );
  const rows = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 20));

  const detailResource = useResource(() => (detail ? api.admin.user(detail) : Promise.resolve(null)), [detail]);

  const setStatusFor = async (id: string, next: 'ACTIVE' | 'SUSPENDED'): Promise<void> => {
    const reason = window.prompt(`Reason for setting this account to ${next}:`, next === 'SUSPENDED' ? 'Player request' : 'Reinstated');
    if (!reason) return;
    try {
      await api.admin.setUserStatus(id, next, reason);
      toast.push(`Account set to ${next}. Recorded in the audit log.`, 'success');
      resource.reload();
      detailResource.reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not change that account.', 'error');
    }
  };

  return (
    <div className="col stack-2">
      <Panel title={`Users · ${formatCoins(total)} accounts`}>
        <div className="row wrap" style={{ marginBottom: '0.8rem', gap: '0.5rem' }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search username or email" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <select className="select" style={{ maxWidth: 200 }} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="PENDING_VERIFICATION">Pending verification</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="CLOSED">Closed</option>
          </select>
          <div className="grow" />
          <span className="tiny dim">Passwords are never stored in a readable form and are never shown here.</span>
        </div>

        <AdminState error={resource.error} loading={resource.loading} empty={!rows.length}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="right">Demo balance</th>
                  <th>Joined</th>
                  <th>Last active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: any) => (
                  <tr key={row.id}>
                    <td>
                      <div className="row" style={{ gap: '0.5rem' }}>
                        <Avatar seed={row.avatarSeed} name={row.username} size={28} />
                        <span className="col" style={{ gap: 0 }}>
                          <strong>{row.username}</strong>
                          <span className="tiny dim num">{row.id}</span>
                        </span>
                      </div>
                    </td>
                    <td className="tiny">{row.email}</td>
                    <td><Badge tone={row.role === 'USER' ? undefined : 'violet'}>{row.role}</Badge></td>
                    <td><Badge tone={row.status === 'ACTIVE' ? 'green' : row.status === 'SUSPENDED' ? 'red' : 'gold'}>{row.status}</Badge></td>
                    <td className="right num">—</td>
                    <td className="tiny dim">{formatDateTime(row.createdAt)}</td>
                    <td className="tiny dim">{timeAgo(row.lastActiveAt)}</td>
                    <td className="actions">
                      <div className="row" style={{ gap: '0.3rem', justifyContent: 'flex-end' }}>
                        <Button size="sm" variant="ghost" onClick={() => setDetail(row.id)}>View</Button>
                        <Button size="sm" variant="ghost" onClick={() => setAdjustFor({ id: row.id, username: row.username })}>Demo coins</Button>
                        {row.status === 'SUSPENDED' ? (
                          <Button size="sm" variant="ghost" onClick={() => void setStatusFor(row.id, 'ACTIVE')}>Reactivate</Button>
                        ) : (
                          <Button size="sm" variant="danger" onClick={() => void setStatusFor(row.id, 'SUSPENDED')}>Suspend</Button>
                        )}
                      </div>
                    </td>
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

      <Modal open={!!detail} title="Player record" onClose={() => setDetail(null)} wide>
        <AdminState error={detailResource.error} loading={detailResource.loading}>
          {detailResource.data ? (
            <div className="col stack-1">
              <div className="row" style={{ gap: '0.7rem' }}>
                <Avatar seed={detailResource.data.user.avatarSeed} name={detailResource.data.user.username} size={48} />
                <div className="col" style={{ gap: 2 }}>
                  <strong style={{ fontSize: '1.1rem' }}>{detailResource.data.user.username}</strong>
                  <span className="tiny dim">{detailResource.data.user.email} · id {detailResource.data.user.id}</span>
                </div>
                <div className="grow" />
                <Badge tone={detailResource.data.user.status === 'ACTIVE' ? 'green' : 'red'}>{detailResource.data.user.status}</Badge>
              </div>

              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                <div className="stat-tile"><div className="k">Demo balance</div><div className="v num">{formatCoins(detailResource.data.wallet?.balance ?? 0)}</div></div>
                <div className="stat-tile"><div className="k">Wagered</div><div className="v num">{formatCoins(detailResource.data.totals?.wagered ?? 0)}</div></div>
                <div className="stat-tile"><div className="k">Rewarded</div><div className="v num">{formatCoins(detailResource.data.totals?.rewarded ?? 0)}</div></div>
                <div className="stat-tile"><div className="k">Transactions</div><div className="v num">{formatCoins(detailResource.data.totals?.txCount ?? 0)}</div></div>
              </div>

              <PlayerProtection userId={detailResource.data.user.id} limits={detailResource.data.limits} onChanged={() => { resource.reload(); detailResource.reload(); }} />

              <Panel title="Recent ledger entries" pad={false}>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="data">
                    <thead><tr><th>When</th><th>Type</th><th className="right">Amount</th><th className="right">After</th><th>Note</th></tr></thead>
                    <tbody>
                      {(detailResource.data.recentTransactions ?? []).map((tx: any) => (
                        <tr key={tx.id}>
                          <td className="tiny dim nowrap">{formatDateTime(tx.createdAt)}</td>
                          <td><span className="tx-type" data-type={tx.type}>{tx.type.replace('_', ' ')}</span></td>
                          <td className={`right num ${tx.amount >= 0 ? 'pos' : 'neg'}`}>{tx.amount >= 0 ? '+' : ''}{tx.amount}</td>
                          <td className="right num">{formatCoins(tx.balanceAfter)}</td>
                          <td className="tiny muted">{tx.description ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Panel title="Recent sessions" pad={false}>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="data">
                    <thead><tr><th>Room</th><th>Round</th><th>Started</th><th className="right">Shots</th><th className="right">Wagered</th><th className="right">Rewarded</th></tr></thead>
                    <tbody>
                      {(detailResource.data.recentSessions ?? []).map((session: any) => (
                        <tr key={session.id}>
                          <td>{session.roomName ?? '—'}</td>
                          <td className="tiny num dim">{session.roundId}</td>
                          <td className="tiny dim">{formatDateTime(session.startedAt)}</td>
                          <td className="right num">{session.shots}</td>
                          <td className="right num">{formatCoins(session.wagered)}</td>
                          <td className="right num pos">{formatCoins(session.rewarded)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          ) : null}
        </AdminState>
      </Modal>

      <AdjustDemoCoins target={adjustFor} onClose={() => setAdjustFor(null)} onSaved={() => { setAdjustFor(null); resource.reload(); detailResource.reload(); }} />
    </div>
  );
}

function AdjustDemoCoins({ target, onClose, onSaved }: { target: { id: string; username: string } | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const toast = useToast();
  const [amount, setAmount] = useState(1000);
  const [reason, setReason] = useState('Manual demo top-up for testing');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={!!target} title={target ? `Adjust demo coins · ${target.username}` : 'Adjust'} onClose={onClose} footer={
      <div className="row" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="gold" loading={busy} disabled={!reason.trim() || amount === 0} onClick={async () => {
          if (!target) return;
          setBusy(true);
          try {
            const result = await api.admin.adjustDemoCoins(target.id, amount, reason.trim());
            toast.push(`Balance set to ${formatCoins(result.balance)} demo coins. Audit entry written.`, 'success');
            onSaved();
          } catch (err) {
            toast.push(err instanceof ApiError ? err.message : 'Adjustment failed.', 'error');
          } finally {
            setBusy(false);
          }
        }}>Apply adjustment</Button>
      </div>
    }>
      <div className="editor-grid">
        <NumberField label="Amount (negative removes)" value={amount} onChange={setAmount} />
      </div>
      <Field label="Reason (required, written to the audit log)" required>
        <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <p className="tiny dim" style={{ marginTop: '0.6rem' }}>
        This only changes virtual demo coins. There is no equivalent operation for real money in this deployment, and creating one is not
        a configuration change — it requires a licensed programme with its own approvals.
      </p>
    </Modal>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }): JSX.Element {
  return (
    <label className="col" style={{ gap: 2 }}>
      <span className="tiny dim upper">{label}</span>
      <input className="number-input" type="number" value={value} step={100} onChange={(event) => onChange(Number(event.target.value) || 0)} />
    </label>
  );
}
