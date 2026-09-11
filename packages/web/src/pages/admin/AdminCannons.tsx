import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePlatform } from '../../state/PlatformContext';
import { useToast } from '../../state/toast';
import { AdminState, DemoNote, NumberCell, SaveButton, useResource } from './shared';
import { PublishBar } from './AdminFish';
import { Badge, Button, Field, Modal, Panel } from '../../components/ui';
import { CannonPreview } from '../../components/previews';
import type { CannonConfig } from '@reef/shared';

type Draft = { name: string; level: number; power: number; shotCost: number; fireRate: number; projectileSpeed: number; enabled: boolean };

const toDraft = (cannon: CannonConfig): Draft => ({
  name: cannon.name,
  level: cannon.level,
  power: cannon.power,
  shotCost: cannon.shotCost,
  fireRate: cannon.fireRate,
  projectileSpeed: cannon.projectileSpeed,
  enabled: cannon.enabled,
});

function diff(before: Draft, after: Draft): Partial<CannonConfig> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof Draft)[]) if (before[key] !== after[key]) patch[key as string] = after[key];
  return patch as Partial<CannonConfig>;
}

export function AdminCannons(): JSX.Element {
  const resource = useResource(() => api.admin.cannons(), []);
  const toast = useToast();
  const { reload } = usePlatform();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const items = resource.data?.items ?? [];

  const save = async (cannon: CannonConfig): Promise<void> => {
    const patch = diff(toDraft(cannon), drafts[cannon.id] ?? toDraft(cannon));
    if (!Object.keys(patch).length) return;
    setSaving(cannon.id);
    try {
      await api.admin.updateCannon(cannon.id, patch);
      toast.push(`${cannon.name} updated.`, 'success');
      setDrafts((current) => {
        const next = { ...current };
        delete next[cannon.id];
        return next;
      });
      resource.reload();
      void reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save that cannon.', 'error');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="col stack-2">
      <p className="small muted" style={{ maxWidth: '70ch', lineHeight: 1.55 }}>
        A cannon's <strong>shot cost is the bet</strong>. Rooms only accept cannons whose cost sits inside their range, so adding a
        level-6 mortar at cost 50 makes it legal only where the operator allows bets of 50 or more.
      </p>

      <Panel pad={false} title={`Cannon table · ${items.length} weapons`}>
        <AdminState error={resource.error} loading={resource.loading} empty={!items.length}>
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Weapon</th>
                  <th>Level</th>
                  <th>Power</th>
                  <th>Shot cost</th>
                  <th>Fire rate</th>
                  <th>Projectile speed</th>
                  <th>Rooms where legal</th>
                  <th>State</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((cannon) => {
                  const draft = drafts[cannon.id] ?? toDraft(cannon);
                  const changed = Object.keys(diff(toDraft(cannon), draft)).length > 0;
                  const legal = (resource.data ? [] : []).concat();
                  void legal;
                  return (
                    <tr key={cannon.id}>
                      <td>
                        <div className="row" style={{ gap: '0.6rem' }}>
                          <CannonPreview cannon={{ ...cannon, ...draft }} width={84} height={70} />
                          <span className="col" style={{ gap: 0 }}>
                            <strong>{draft.name}</strong>
                            <span className="tiny dim num">{cannon.key}</span>
                          </span>
                        </div>
                      </td>
                      <td><NumberCell label="" value={draft.level} min={1} max={20} onChange={(value) => setDrafts((c) => ({ ...c, [cannon.id]: { ...draft, level: Math.max(1, Math.round(value)) } }))} /></td>
                      <td><NumberCell label="" value={draft.power} min={1} max={1000} onChange={(value) => setDrafts((c) => ({ ...c, [cannon.id]: { ...draft, power: Math.max(1, Math.round(value)) } }))} /></td>
                      <td><NumberCell label="" value={draft.shotCost} min={1} max={100000} onChange={(value) => setDrafts((c) => ({ ...c, [cannon.id]: { ...draft, shotCost: Math.max(1, Math.round(value)) } }))} /></td>
                      <td><NumberCell label="" value={draft.fireRate} step={0.1} min={0.2} max={20} onChange={(value) => setDrafts((c) => ({ ...c, [cannon.id]: { ...draft, fireRate: Math.max(0.2, value) } }))} /></td>
                      <td><NumberCell label="" value={draft.projectileSpeed} step={50} min={100} max={8000} onChange={(value) => setDrafts((c) => ({ ...c, [cannon.id]: { ...draft, projectileSpeed: Math.max(100, value) } }))} /></td>
                      <td className="tiny dim">{draft.shotCost} demo per shot</td>
                      <td>
                        <button
                          type="button"
                          className="mini-toggle"
                          data-on={draft.enabled}
                          onClick={() => setDrafts((c) => ({ ...c, [cannon.id]: { ...draft, enabled: !draft.enabled } }))}
                        >
                          {draft.enabled ? 'ON' : 'OFF'}
                        </button>
                      </td>
                      <td className="actions">
                        {changed ? (
                          <div className="row" style={{ gap: '0.35rem', justifyContent: 'flex-end' }}>
                            <Button size="sm" variant="ghost" onClick={() => setDrafts((c) => { const n = { ...c }; delete n[cannon.id]; return n; })}>Revert</Button>
                            <Button size="sm" variant="primary" loading={saving === cannon.id} onClick={() => void save(cannon)}>Save</Button>
                          </div>
                        ) : (
                          <SaveButton saving={false} dirty={false}>—</SaveButton>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AdminState>
        <div className="row-between" style={{ padding: '0.7rem 1rem' }}>
          <DemoNote />
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>+ New cannon</Button>
        </div>
      </Panel>

      <PublishBar onPublished={() => { resource.reload(); void reload(); }} />

      <NewCannon open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); resource.reload(); void reload(); }} />
    </div>
  );
}

function NewCannon({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const toast = useToast();
  const [form, setForm] = useState({ key: '', name: '', level: 6, power: 40, shotCost: 40, fireRate: 1.6, projectileSpeed: 2100 });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      title="New cannon"
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" loading={busy} disabled={!form.key || !form.name} onClick={async () => {
            setBusy(true);
            try {
              await api.admin.createCannon({ ...form, enabled: true });
              toast.push('Cannon created.', 'success');
              onCreated();
            } catch (err) {
              toast.push(err instanceof ApiError ? err.message : 'Could not create the cannon.', 'error');
            } finally {
              setBusy(false);
            }
          }}>Create</Button>
        </div>
      }
    >
      <div className="editor-grid">
        <Field label="Key" required><input className="input" value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder="deep_mortar" /></Field>
        <Field label="Name" required><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Deep Mortar" /></Field>
        <NumberCell label="Level" value={form.level} min={1} max={20} onChange={(value) => setForm({ ...form, level: value })} />
        <NumberCell label="Power" value={form.power} min={1} onChange={(value) => setForm({ ...form, power: value })} />
        <NumberCell label="Shot cost" value={form.shotCost} min={1} onChange={(value) => setForm({ ...form, shotCost: value })} />
        <NumberCell label="Fire rate" value={form.fireRate} step={0.1} onChange={(value) => setForm({ ...form, fireRate: value })} />
        <NumberCell label="Projectile speed" value={form.projectileSpeed} step={50} onChange={(value) => setForm({ ...form, projectileSpeed: value })} />
      </div>
      <div style={{ marginTop: '0.8rem' }}><Badge tone="gold">Cost {form.shotCost} · power {form.power}</Badge></div>
    </Modal>
  );
}
