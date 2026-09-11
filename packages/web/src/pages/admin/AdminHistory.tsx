import { useState } from 'react';
import { api } from '../../lib/api';
import { AdminState, useResource } from './shared';
import { Badge, Button, Panel, formatCoins, formatDateTime } from '../../components/ui';

export function AdminHistory(): JSX.Element {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState('');
  const [roomId, setRoomId] = useState('');
  const resource = useResource(() => api.admin.history({ page, limit: 50, result: result || undefined, roomId: roomId || undefined }), [page, result, roomId]);
  const rows = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <Panel title={`Recorded shots · ${formatCoins(total)}`}>
      <div className="row wrap" style={{ marginBottom: '0.8rem', gap: '0.5rem' }}>
        <select className="select" style={{ maxWidth: 180 }} value={result} onChange={(event) => { setResult(event.target.value); setPage(1); }}>
          <option value="">Any result</option>
          <option value="KILL">Kills</option>
          <option value="HIT">Hits</option>
          <option value="MISSED">Misses</option>
        </select>
        <input className="input" style={{ maxWidth: 220 }} placeholder="Room id" value={roomId} onChange={(event) => { setRoomId(event.target.value); setPage(1); }} />
        <div className="grow" />
        <a className="btn btn-ghost btn-sm" href={api.admin.exportUrl('history')}>Download CSV</a>
      </div>
      <AdminState error={resource.error} loading={resource.loading} empty={!rows.length}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th><th>Player</th><th>Room</th><th>Cannon</th><th>Fish</th><th className="right">Bet</th><th className="right">Reward</th><th>Result</th><th>Round</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => (
                <tr key={row.id}>
                  <td className="tiny dim nowrap">{formatDateTime(row.createdAt)}</td>
                  <td><strong>{row.username}</strong></td>
                  <td>{row.roomName}</td>
                  <td className="tiny">{row.cannonName}</td>
                  <td>{row.fishName ?? <span className="dim">—</span>}</td>
                  <td className="right num">-{row.shotCost}</td>
                  <td className="right num">{row.reward > 0 ? <span className="pos">+{row.reward}</span> : <span className="dim">0</span>}</td>
                  <td><Badge tone={row.result === 'KILL' ? 'green' : row.result === 'HIT' ? 'cyan' : undefined}>{row.result}</Badge></td>
                  <td className="tiny dim num">{row.roundId}</td>
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
  );
}
