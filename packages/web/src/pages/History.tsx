import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Button, Empty, Panel, Skeleton, formatCoins, formatSigned, formatDateTime } from '../components/ui';
import type { GameHistoryEntry } from '@reef/shared';

export function History(): JSX.Element {
  const [items, setItems] = useState<GameHistoryEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const limit = 25;

  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .history({ page, limit })
      .then((payload) => {
        if (!alive) return;
        setItems(payload.items);
        setTotal(payload.total);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'History unavailable.'));
    return () => {
      alive = false;
    };
  }, [page]);

  const pages = Math.max(1, Math.ceil(total / limit));
  const totals = (items ?? []).reduce(
    (acc, entry) => ({ wagered: acc.wagered + entry.shotCost, rewarded: acc.rewarded + entry.reward, kills: acc.kills + (entry.result === 'KILL' ? 1 : 0) }),
    { wagered: 0, rewarded: 0, kills: 0 },
  );

  return (
    <div style={{ width: 'min(1240px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Game history</h1>
          <p className="sub">Every shot you took, exactly as the server recorded it.</p>
        </div>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <Badge tone="cyan">{formatCoins(total)} entries</Badge>
          <Badge tone="gold">Page {page} / {pages}</Badge>
        </div>
      </div>

      {error ? <div className="notice-box danger small" style={{ marginBottom: '1rem' }}>{error}</div> : null}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: '1rem' }}>
        <div className="stat-tile"><div className="k">Shots on this page</div><div className="v num">{items?.length ?? '—'}</div></div>
        <div className="stat-tile"><div className="k">Bets placed</div><div className="v num" style={{ color: 'var(--coral)' }}>{formatCoins(totals.wagered)}</div></div>
        <div className="stat-tile"><div className="k">Rewards won</div><div className="v num" style={{ color: 'var(--aqua)' }}>{formatCoins(totals.rewarded)}</div></div>
        <div className="stat-tile"><div className="k">Net on page</div><div className="v num">{formatSigned(totals.rewarded - totals.wagered)}</div></div>
      </div>

      <Panel pad={false}>
        {items === null ? (
          <div style={{ padding: '1rem' }} className="col"><Skeleton height={30} /><Skeleton height={30} /><Skeleton height={30} /><Skeleton height={30} /></div>
        ) : items.length === 0 ? (
          <Empty title="No history yet" body="Once you shoot in a room, every shot and reward is recorded here." />
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Room</th>
                  <th>Fish</th>
                  <th>Result</th>
                  <th className="right">Bet</th>
                  <th className="right">Reward</th>
                  <th className="right">Net</th>
                  <th>Round</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="tiny dim nowrap">{formatDateTime(entry.createdAt)}</td>
                    <td>{entry.roomName}</td>
                    <td>{entry.fishName ?? <span className="dim">—</span>}</td>
                    <td>
                      <Badge tone={entry.result === 'KILL' ? 'green' : entry.result === 'HIT' ? 'cyan' : undefined}>{entry.result}</Badge>
                    </td>
                    <td className="right num">-{entry.shotCost}</td>
                    <td className="right num">{entry.reward > 0 ? <span className="pos">+{entry.reward}</span> : <span className="dim">0</span>}</td>
                    <td className="right num">
                      <span className={entry.reward - entry.shotCost >= 0 ? 'pos' : 'neg'}>{formatSigned(entry.reward - entry.shotCost)}</span>
                    </td>
                    <td className="tiny dim num">{entry.roundId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination" style={{ padding: '0.7rem 1rem' }}>
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</Button>
          <span className="tiny dim">Page {page} of {pages}</span>
          <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next →</Button>
        </div>
      </Panel>
    </div>
  );
}
