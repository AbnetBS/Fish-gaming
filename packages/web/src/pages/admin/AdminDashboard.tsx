import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useResource, AdminState } from './shared';
import { Badge, Panel, Stat, formatCoins } from '../../components/ui';
import { BarList, HourHistogram, Sparkline } from '../../components/charts';

export function AdminDashboard(): JSX.Element {
  const resource = useResource(() => api.admin.dashboard(), []);
  const stats = resource.data;

  return (
    <div className="col stack-2">
      <AdminState error={resource.error} loading={resource.loading}>
        {stats ? (
          <>
            <div className="notice-box info small">
              <strong>DEMO statistics.</strong> Every figure below describes virtual demo coins recorded in the ledger. This deployment
              holds no real-money balance and processes no payments.
            </div>

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              <Stat label="Total users" value={formatCoins(stats.totalUsers)} tone="cyan" hint={`${formatCoins(stats.activeUsers)} active`} />
              <Stat label="Active rooms" value={formatCoins(stats.activeRooms)} hint={`config ${stats.configuration?.version ?? '—'}`} />
              <Stat label="Games today" value={formatCoins(stats.gamesToday)} />
              <Stat label="Shots today" value={formatCoins(stats.shotsToday)} />
              <Stat label="Demo coins wagered today" value={formatCoins(stats.demoCoinsWageredToday)} tone="gold" />
              <Stat label="Demo rewards today" value={formatCoins(stats.demoCoinsRewardedToday)} tone="green" />
              <Stat label="Measured demo RTP today" value={stats.rtpToday === null ? '—' : `${(stats.rtpToday * 100).toFixed(1)}%`} tone={stats.rtpToday && stats.rtpToday > 1.15 ? 'red' : 'cyan'} hint="rewarded ÷ wagered" />
              <Stat label="Players online" value={formatCoins(stats.onlinePlayers)} hint="live sockets" />
            </div>

            {stats.ledgerIntegrity && stats.ledgerIntegrity.mismatches.length > 0 ? (
              <div className="notice-box danger small">
                <strong>Ledger reconciliation found {stats.ledgerIntegrity.mismatches.length} mismatch(es).</strong>
                <pre className="audit-diff" style={{ marginTop: 6 }}>{stats.ledgerIntegrity.mismatches.join('\n')}</pre>
              </div>
            ) : (
              <div className="notice-box small">Ledger reconciliation: {stats.ledgerIntegrity?.checked ?? 0} wallets balance exactly against their transactions.</div>
            )}

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <Panel title="New players · last 14 days">
                <Sparkline points={stats.usersOverTime.map((row) => row.count)} label="users over time" />
                <p className="tiny dim">{stats.usersOverTime.at(-1)?.date ?? '—'}</p>
              </Panel>
              <Panel title="Shots · last 14 days">
                <Sparkline points={stats.shotsOverTime.map((row) => row.count)} label="shots over time" />
                <p className="tiny dim">{stats.shotsOverTime.at(-1)?.date ?? '—'}</p>
              </Panel>
            </div>

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
              <Panel title="Activity by hour (last 24h)">
                <HourHistogram values={stats.activityByHour} />
              </Panel>
              <Panel title="Popular rooms">
                <BarList items={stats.popularRooms.map((room) => ({ name: room.name, value: room.count }))} />
              </Panel>
              <Panel title="Most caught fish">
                <BarList tone="gold" items={stats.popularFish.map((fish) => ({ name: fish.name, value: fish.count }))} />
              </Panel>
            </div>

            <div className="row wrap" style={{ gap: '0.5rem' }}>
              <Link className="btn btn-ghost btn-sm" to="/admin/fish">Edit fish table</Link>
              <Link className="btn btn-ghost btn-sm" to="/admin/settings">Game settings</Link>
              <Link className="btn btn-ghost btn-sm" to="/admin/audit">Audit log</Link>
              <Link className="btn btn-ghost btn-sm" to="/admin/reports">Round reports</Link>
              {stats.configuration?.isDraftAhead ? <Badge tone="gold">Unpublished configuration changes pending</Badge> : null}
            </div>
          </>
        ) : null}
      </AdminState>
    </div>
  );
}
