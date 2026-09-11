import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useToast } from '../../state/toast';
import { usePlatform } from '../../state/PlatformContext';
import { AdminState, useResource } from './shared';
import { Badge, Button, Panel, Toggle, formatDateTime } from '../../components/ui';

export function AdminSystem(): JSX.Element {
  const resource = useResource(() => api.admin.settings(), []);
  const toast = useToast();
  const { meta } = usePlatform();
  const [maintenance, setMaintenance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('Scheduled maintenance window');
  const [health, setHealth] = useState<{ status: string; db: string; version: string } | null>(null);

  useEffect(() => {
    api.health().then((payload) => {
      setMaintenance(payload.maintenance);
      setHealth(payload as any);
    }).catch(() => undefined);
  }, []);

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.admin.setMaintenance(maintenance, reason.trim() || undefined);
      toast.push(result.maintenance ? 'Maintenance mode enabled — players cannot start new rounds.' : 'Maintenance mode disabled.', result.maintenance ? 'warn' : 'success');
      resource.reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not change maintenance state.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col stack-2">
      <Panel title="Operational controls">
        <div className="col" style={{ gap: '0.9rem' }}>
          <div className="row-between">
            <div>
              <strong>Maintenance mode</strong>
              <div className="tiny dim">Closes live rounds, blocks joining and stops new shots. Players see a clear notice.</div>
            </div>
            <Toggle on={maintenance} label="Maintenance mode" onChange={setMaintenance} />
          </div>
          <label className="field">
            <span className="tiny dim upper">Reason (recorded in the audit log)</span>
            <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button variant={maintenance ? 'danger' : 'primary'} loading={busy} onClick={() => void apply()}>
              {maintenance ? 'Enable maintenance' : 'Disable maintenance'}
            </Button>
            <span className="tiny dim">Current state: {maintenance ? 'ON' : 'OFF'}</span>
          </div>
        </div>
      </Panel>

      <div className="notice-box small">
        <strong>Real-money mode: permanently disabled in this deployment.</strong>
        <p className="tiny" style={{ marginTop: '0.5rem', lineHeight: 1.6, color: 'var(--muted)' }}>
          <code>REAL_MONEY_ENABLED</code> is an environment-level flag read at process start, not a row in this table, and the admin
          panel refuses to write keys that look like money or payment configuration. Enabling real money is a licensing and compliance
          programme — age verification, KYC/AML, geographic restrictions, payment-provider approval, responsible-gaming controls, tax and
          advertising rules — that must be completed independently before any code path is turned on. This software provides no bypass.
        </p>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <Panel title="Runtime">
          <AdminState error={resource.error} loading={resource.loading}>
            <dl className="kv">
              <dt>Currency</dt><dd>{meta?.currency.label ?? 'DEMO COINS'} (no cash value)</dd>
              <dt>Starting balance</dt><dd className="num">{meta?.currency.startingBalance ?? 10000}</dd>
              <dt>Active config</dt><dd className="num">{meta?.configVersion ?? '—'}</dd>
              <dt>API health</dt><dd>{health ? `${health.status} · db ${health.db}` : '—'}</dd>
              <dt>Build</dt><dd className="num">{health?.version ?? '—'}</dd>
              <dt>Simulation</dt><dd className="num">{meta?.game.tickMs ?? 50}ms tick / {meta?.game.snapshotMs ?? 50}ms snapshot</dd>
              <dt>Logical resolution</dt><dd className="num">{meta?.game.width ?? 1920}×{meta?.game.height ?? 1080}</dd>
            </dl>
          </AdminState>
        </Panel>

        <Panel title="System settings" pad={false}>
          <AdminState error={resource.error} loading={resource.loading}>
            <div className="table-wrap" style={{ border: 0, borderRadius: 0, maxHeight: 300 }}>
              <table className="data">
                <thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
                <tbody>
                  {(resource.data?.system ?? []).map((row: any) => (
                    <tr key={row.key}>
                      <td className="tiny num">{row.key}</td>
                      <td className="tiny">{row.value}</td>
                      <td className="tiny dim">{formatDateTime(row.updatedAt ?? row.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AdminState>
        </Panel>
      </div>

      <Panel title="Flags in force">
        <div className="row wrap" style={{ gap: '0.4rem' }}>
          <Badge tone="red">REAL_MONEY_ENABLED = false</Badge>
          <Badge tone="green">DEMO_COINS only</Badge>
          <Badge tone="cyan">Server-authoritative economy</Badge>
          <Badge tone="violet">Versioned configuration</Badge>
          <Badge tone="gold">Append-only audit</Badge>
        </div>
      </Panel>
    </div>
  );
}
