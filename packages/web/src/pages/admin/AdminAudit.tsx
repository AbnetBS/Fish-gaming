import { useState } from 'react';
import { api } from '../../lib/api';
import { AdminState, useResource } from './shared';
import { Badge, Button, Panel, formatDateTime } from '../../components/ui';

export function AdminAudit(): JSX.Element {
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const resource = useResource(() => api.admin.audit({ page, limit: 50, entity: entity || undefined, action: action || undefined }), [page, entity, action]);
  const rows = resource.data?.items ?? [];
  const total = resource.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <Panel title={`Audit log · ${total} immutable entries`}>
      <div className="row wrap" style={{ marginBottom: '0.8rem', gap: '0.5rem' }}>
        <select className="select" style={{ maxWidth: 190 }} value={entity} onChange={(event) => { setEntity(event.target.value); setPage(1); }}>
          <option value="">All entities</option>
          <option value="fish">fish</option>
          <option value="cannons">cannons</option>
          <option value="game_rooms">game_rooms</option>
          <option value="game_configs">game_configs</option>
          <option value="system_settings">system_settings</option>
          <option value="users">users</option>
          <option value="wallets">wallets</option>
        </select>
        <input className="input" style={{ maxWidth: 200 }} placeholder="Action (e.g. FISH_UPDATE)" value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} />
        <div className="grow" />
        <Badge tone="cyan">Append-only: the table rejects UPDATE and DELETE at the engine level</Badge>
      </div>

      <AdminState error={resource.error} loading={resource.loading} empty={!rows.length}>
        <div className="col" style={{ gap: '0.2rem' }}>
          {rows.map((row: any) => (
            <div className="audit-row" key={row.id}>
              <div className="col" style={{ gap: 1 }}>
                <strong className="small">{row.adminUsername ?? 'system'}</strong>
                <span className="tiny dim">{formatDateTime(row.createdAt)}</span>
              </div>
              <div className="row wrap" style={{ gap: '0.25rem' }}>
                <Badge tone="violet">{row.action}</Badge>
                <span className="tiny dim num">{row.entity}{row.entityId ? ` · ${row.entityId}` : ''}</span>
              </div>
              <div className="col" style={{ gap: '0.3rem' }}>
                {row.previousValue ? <pre className="audit-diff"><span className="from">before</span>{'\n'}{pretty(row.previousValue)}</pre> : <span className="tiny dim">no previous value (create)</span>}
                {row.newValue ? <pre className="audit-diff"><span className="to">after</span>{'\n'}{pretty(row.newValue)}</pre> : null}
                {row.metadata ? <span className="tiny dim">{pretty(row.metadata)}</span> : null}
              </div>
            </div>
          ))}
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

function pretty(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 1);
  } catch {
    return value;
  }
}
