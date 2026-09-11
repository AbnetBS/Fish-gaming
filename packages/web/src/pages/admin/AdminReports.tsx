import { useState } from 'react';
import { api } from '../../lib/api';
import { AdminState, useResource } from './shared';
import { Badge, Button, Empty, Modal, Panel, Stat, formatCoins, formatDateTime } from '../../components/ui';

export function AdminReports(): JSX.Element {
  const [limit, setLimit] = useState(25);
  const resource = useResource(() => api.admin.rounds({ limit }), [limit]);
  const overview = useResource(() => api.admin.overview(), []);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const audit = useResource(() => (auditFor ? api.admin.roundAudit(auditFor) : Promise.resolve(null)), [auditFor]);

  const rows = resource.data?.items ?? [];
  const demo = overview.data?.demo;

  return (
    <div className="col stack-2">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <Stat label="Shots today (demo)" value={formatCoins(demo?.shotsToday ?? 0)} tone="cyan" />
        <Stat label="Games today" value={formatCoins(demo?.gamesToday ?? 0)} />
        <Stat label="Demo wagered" value={formatCoins(demo?.demoCoinsWageredToday ?? 0)} tone="gold" />
        <Stat label="Demo rewarded" value={formatCoins(demo?.demoCoinsRewardedToday ?? 0)} tone="green" />
        <Stat label="Measured RTP" value={demo?.rtpToday == null ? '—' : `${(demo.rtpToday * 100).toFixed(1)}%`} tone={demo && demo.rtpToday !== null && demo.rtpToday > 1.15 ? 'red' : 'cyan'} />
      </div>

      <Panel title="Round report" actions={
        <div className="row" style={{ gap: '0.4rem' }}>
          <select className="select" style={{ maxWidth: 120 }} value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            <option value={10}>10 rows</option>
            <option value={25}>25 rows</option>
            <option value={100}>100 rows</option>
          </select>
          <a className="btn btn-ghost btn-sm" href={api.admin.exportUrl('rounds')}>CSV</a>
        </div>
      } pad={false}>
        <AdminState error={resource.error} loading={resource.loading} empty={!rows.length}>
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="data">
              <thead>
                <tr><th>Round</th><th>Room</th><th>Config</th><th>Started</th><th className="right">Players</th><th className="right">Shots</th><th className="right">Wagered</th><th className="right">Rewarded</th><th className="right">RTP</th><th>State</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((row: any) => (
                  <tr key={row.roundId}>
                    <td className="num tiny">{row.roundId}</td>
                    <td>{row.roomName}</td>
                    <td className="num tiny">{row.configVersion}</td>
                    <td className="tiny dim">{formatDateTime(row.startedAt)}</td>
                    <td className="right num">{row.players}</td>
                    <td className="right num">{row.shots}</td>
                    <td className="right num">{formatCoins(row.wagered)}</td>
                    <td className="right num pos">{formatCoins(row.rewarded)}</td>
                    <td className="right num">{row.rtp === null ? '—' : `${(row.rtp * 100).toFixed(1)}%`}</td>
                    <td><Badge tone={row.status === 'ACTIVE' ? 'green' : undefined}>{row.status}</Badge></td>
                    <td className="actions"><Button size="sm" variant="ghost" onClick={() => setAuditFor(row.roundId)}>Audit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminState>
      </Panel>

      <Panel title="Live rooms">
        {overview.data?.liveRooms?.length ? (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
            {overview.data.liveRooms.map((room: any) => (
              <div className="stat-tile" key={room.roomId}>
                <div className="k">Round {room.roundId}</div>
                <div className="v num" style={{ fontSize: '1.15rem' }}>{room.players} players · {room.fish} fish</div>
                <div className="tiny dim" style={{ marginTop: 4 }}>
                  cfg {room.configVersion} · {Math.round(room.roundAgeMs / 1000)}s old · {room.totals.shots} shots · {formatCoins(room.totals.wagered)} in / {formatCoins(room.totals.rewarded)} out
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="🫧" title="No live rounds" body="Rounds start when a player enters a room and close after the round duration or when the room empties." />
        )}
      </Panel>

      <Modal open={!!auditFor} title={`Round audit · ${auditFor ?? ''}`} onClose={() => setAuditFor(null)} wide>
        <AdminState error={audit.error} loading={audit.loading}>
          {audit.data ? (
            <div className="col stack-1">
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                <Stat label="Status" value={<span style={{ fontSize: '1.05rem' }}>{audit.data.status}</span>} />
                <Stat label="Config version" value={<span style={{ fontSize: '1.05rem' }}>{audit.data.configVersion}</span>} />
                <Stat label="Seed" value={<span style={{ fontSize: '1.05rem' }}>{audit.data.seed}</span>} hint="replays the exact spawn sequence" />
                <Stat label="Measured RTP" value={audit.data.rtp === null ? '—' : `${(audit.data.rtp * 100).toFixed(1)}%`} tone={audit.data.rtp > 1.15 ? 'red' : 'cyan'} />
              </div>
              <p className="tiny dim">
                Started {formatDateTime(audit.data.startedAt)} · ended {formatDateTime(audit.data.endedAt)} · totals {audit.data.totals.shots} shots,{' '}
                {formatCoins(audit.data.totals.wagered)} wagered, {formatCoins(audit.data.totals.rewarded)} rewarded.
              </p>
              <Panel title="Per-player reconciliation" pad={false}>
                <div className="table-wrap" style={{ border: 0 }}>
                  <table className="data">
                    <thead><tr><th>Player</th><th className="right">Shots</th><th className="right">Kills</th><th className="right">Wagered</th><th className="right">Rewarded</th><th className="right">Net</th></tr></thead>
                    <tbody>
                      {audit.data.perPlayer.map((row: any) => (
                        <tr key={row.username}>
                          <td><strong>{row.username}</strong></td>
                          <td className="right num">{row.shots}</td>
                          <td className="right num">{row.kills}</td>
                          <td className="right num">{formatCoins(row.wagered)}</td>
                          <td className="right num pos">{formatCoins(row.rewarded)}</td>
                          <td className={`right num ${row.net >= 0 ? 'pos' : 'neg'}`}>{row.net >= 0 ? '+' : ''}{row.net}</td>
                        </tr>
                      ))}
                      {!audit.data.perPlayer.length ? <tr><td colSpan={6} className="tiny dim">No shots recorded for this round.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <p className="tiny dim" style={{ lineHeight: 1.6 }}>
                The configuration snapshot below is what this round actually ran with. Combined with the seed it is enough to re-derive
                the spawn sequence and verify any disputed outcome.
              </p>
              <pre className="audit-diff" style={{ maxHeight: 260 }}>{JSON.stringify({ fish: audit.data.configuration?.fish?.map((f: any) => ({ key: f.key, health: f.health, reward: f.reward, speed: f.speed, spawnWeight: f.spawnWeight })) ?? null, cannons: audit.data.configuration?.cannons ?? null, settings: audit.data.configuration?.settings ?? null }, null, 1)}</pre>
            </div>
          ) : null}
        </AdminState>
      </Modal>
    </div>
  );
}
