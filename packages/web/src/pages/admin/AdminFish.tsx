import { useMemo, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePlatform } from '../../state/PlatformContext';
import { useToast } from '../../state/toast';
import { AdminState, DemoNote, NumberCell, SaveButton, useResource } from './shared';
import { Badge, Button, Field, Modal, Panel, formatCoins } from '../../components/ui';
import { FishPreview } from '../../components/previews';
import type { FishConfig, MovementPattern } from '@reef/shared';

const PATTERNS: MovementPattern[] = ['STRAIGHT', 'DIAGONAL', 'SINE', 'CIRCULAR', 'CURVED', 'WANDER', 'BOSS'];
const CATEGORIES = ['COMMON', 'MEDIUM', 'LARGE', 'RARE', 'BOSS', 'SPECIAL_GOLDEN', 'SPECIAL_TREASURE', 'SPECIAL_SPEED', 'SPECIAL_BOMB'] as const;

type Draft = {
  name: string;
  health: number;
  reward: number;
  speed: number;
  size: number;
  spawnWeight: number;
  movementPattern: MovementPattern;
  minSpawnIntervalMs: number;
  enabled: boolean;
  palette: number;
  category: (typeof CATEGORIES)[number];
  special: string | null;
  sortOrder: number;
};

function toDraft(fish: FishConfig): Draft {
  return {
    name: fish.name,
    health: fish.health,
    reward: fish.reward,
    speed: fish.speed,
    size: fish.size,
    spawnWeight: fish.spawnWeight,
    movementPattern: fish.movementPattern,
    minSpawnIntervalMs: fish.minSpawnIntervalMs,
    enabled: fish.enabled,
    palette: fish.palette,
    category: fish.category,
    special: fish.special,
    sortOrder: fish.sortOrder,
  };
}

function diff(before: Draft, after: Draft): Partial<FishConfig> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof Draft)[]) {
    if (before[key] !== after[key]) patch[key as string] = after[key];
  }
  return patch as Partial<FishConfig>;
}

export function AdminFish(): JSX.Element {
  const resource = useResource(() => api.admin.fish(), []);
  const { config, meta, reload } = usePlatform();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const items = resource.data?.items ?? [];
  const draftFor = (fish: FishConfig): Draft => drafts[fish.id] ?? toDraft(fish);

  const dirty = useMemo(
    () => items.filter((fish) => Object.keys(diff(toDraft(fish), draftFor(fish))).length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, drafts],
  );

  const publishState = meta?.configVersion ?? config?.version ?? '—';

  const save = async (fish: FishConfig): Promise<void> => {
    const patch = diff(toDraft(fish), draftFor(fish));
    if (!Object.keys(patch).length) return;
    setSaving(fish.id);
    try {
      const result = await api.admin.updateFish(fish.id, patch);
      toast.push(`${result.fish.name} updated. Publish a configuration version to apply it to new rounds.`, 'success');
      setDrafts((current) => {
        const next = { ...current };
        delete next[fish.id];
        return next;
      });
      resource.reload();
      void reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save that fish.', 'error');
    } finally {
      setSaving(null);
    }
  };

  const disable = async (fish: FishConfig): Promise<void> => {
    if (!window.confirm(`Disable ${fish.name}? Existing history keeps its record and the species stops spawning.`)) return;
    try {
      await api.admin.deleteFish(fish.id);
      toast.push(`${fish.name} disabled.`, 'info');
      resource.reload();
      void reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not disable that fish.', 'error');
    }
  };

  return (
    <div className="col stack-2">
      <div className="row-between wrap">
        <p className="small muted" style={{ maxWidth: '62ch', lineHeight: 1.55 }}>
          The fish table is the economy. Health is the number of damage points a fish can absorb, reward is what its killer is paid,
          spawn weight is its share of the spawn lottery, and the minimum interval stops one species flooding the reef.
        </p>
        <div className="row" style={{ gap: '0.5rem' }}>
          <Badge tone="cyan">Active config {publishState}</Badge>
          {dirty.length ? <Badge tone="gold">{dirty.length} unsaved</Badge> : null}
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>+ New fish</Button>
        </div>
      </div>

      <Panel pad={false} title={`Fish configuration · ${items.length} species`}>
        <AdminState error={resource.error} loading={resource.loading} empty={!items.length}>
          <div className="col" style={{ padding: '0.7rem', gap: '0.55rem' }}>
            {items.map((fish) => {
              const draft = draftFor(fish);
              const changed = Object.keys(diff(toDraft(fish), draft)).length > 0;
              return (
                <div className="row-editor" key={fish.id} style={{ gridTemplateColumns: 'minmax(150px,1.3fr) repeat(6, minmax(78px,1fr)) auto' }}>
                  <div className="row" style={{ gap: '0.5rem', minWidth: 0 }}>
                    <FishPreview species={{ ...fish, ...draft }} size={58} animate={false} />
                    <span className="name">
                      <strong>{draft.name}</strong>
                      <span>{fish.key} · {fish.category}{fish.special ? ` · ${fish.special}` : ''}</span>
                    </span>
                  </div>
                  <NumberCell label="Health" value={draft.health} min={1} max={100000} onChange={(value) => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, health: Math.max(1, Math.round(value)) } }))} />
                  <NumberCell label="Reward" value={draft.reward} min={0} max={1000000} onChange={(value) => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, reward: Math.max(0, Math.round(value)) } }))} />
                  <NumberCell label="Speed" value={draft.speed} min={1} max={4000} onChange={(value) => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, speed: Math.max(1, value) } }))} />
                  <NumberCell label="Size" value={draft.size} min={4} max={400} onChange={(value) => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, size: Math.max(4, value) } }))} />
                  <NumberCell label="Weight" value={draft.spawnWeight} step={0.5} min={0} max={1000} onChange={(value) => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, spawnWeight: Math.max(0, value) } }))} />
                  <label className="col" style={{ gap: 2 }}>
                    <span className="tiny dim upper">Movement</span>
                    <select
                      className="select"
                      style={{ minHeight: 40, padding: '0.3rem 1.6rem 0.3rem 0.5rem' }}
                      value={draft.movementPattern}
                      onChange={(event) => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, movementPattern: event.target.value as MovementPattern } }))}
                    >
                      {PATTERNS.map((pattern) => (
                        <option key={pattern} value={pattern}>{pattern}</option>
                      ))}
                    </select>
                  </label>
                  <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
                    <button
                      type="button"
                      className="mini-toggle"
                      data-on={draft.enabled}
                      title={draft.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                      onClick={() => setDrafts((c) => ({ ...c, [fish.id]: { ...draft, enabled: !draft.enabled } }))}
                    >
                      {draft.enabled ? 'ON' : 'OFF'}
                    </button>
                    <SaveButton saving={saving === fish.id} dirty={changed} />
                    <button type="button" className="icon-btn" onClick={() => void disable(fish)} title="Remove from spawns (soft delete)">🗑</button>
                  </div>
                  {changed ? (
                    <div style={{ gridColumn: '1 / -1' }} className="row wrap" >
                      <span className="tiny dim">Changes pending: {Object.keys(diff(toDraft(fish), draft)).join(', ')}</span>
                      <Button size="sm" variant="primary" onClick={() => void save(fish)}>Save {fish.name}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDrafts((c) => { const n = { ...c }; delete n[fish.id]; return n; })}>Revert</Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </AdminState>
        <DemoNote />
      </Panel>

      <PublishBar onPublished={() => { resource.reload(); void reload(); }} />

      <NewFishModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          resource.reload();
          void reload();
        }}
      />
    </div>
  );
}

export function PublishBar({ onPublished }: { onPublished: () => void }): JSX.Element {
  const { meta, reload } = usePlatform();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');

  const publish = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.admin.publish(notes.trim() || 'Operator configuration update.');
      toast.push(`Configuration ${result.version} published. New rounds use it immediately.`, 'success');
      setNotes('');
      await reload();
      onPublished();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Publish failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Configuration versioning">
      <div className="row-between wrap" style={{ gap: '0.7rem' }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="small">
            Active version: <strong className="num">{meta?.configVersion ?? '—'}</strong>
          </span>
          <span className="tiny dim">
            Rounds already in play keep the version they started with. Publishing creates a new immutable snapshot that every new round
            — and every audit report — can reference.
          </span>
        </div>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <input className="input" style={{ minWidth: 240, maxWidth: 320 }} placeholder="Change note (recorded in the audit log)" value={notes} onChange={(event) => setNotes(event.target.value)} />
          <Button variant="gold" loading={busy} onClick={() => void publish()}>Publish new version</Button>
        </div>
      </div>
    </Panel>
  );
}

function NewFishModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const toast = useToast();
  const [form, setForm] = useState({ key: '', name: '', health: 3, reward: 5, speed: 150, size: 34, spawnWeight: 10, movementPattern: 'SINE' as MovementPattern, category: 'MEDIUM' as (typeof CATEGORIES)[number], palette: 2, minSpawnIntervalMs: 500 });
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.admin.createFish({ ...form, rarity: 2, enabled: true, sortOrder: 99, special: null });
      toast.push(`${form.name || form.key} created.`, 'success');
      onCreated();
      setForm({ ...form, key: '', name: '' });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not create the fish.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New fish species"
      onClose={onClose}
      footer={
        <div className="row-between">
          <span className="tiny dim">Rewards are paid per kill and are identical for all players.</span>
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="primary" size="sm" loading={busy} disabled={!form.key || !form.name} onClick={() => void create()}>Create fish</Button>
          </div>
        </div>
      }
    >
      <div className="editor-grid">
        <Field label="Key" required hint="snake_case">
          <input className="input" value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder="golden_fang" />
        </Field>
        <Field label="Name" required>
          <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Golden Fang" />
        </Field>
        <Field label="Category">
          <select className="select" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as (typeof CATEGORIES)[number] })}>
            {CATEGORIES.map((category) => <option key={category}>{category}</option>)}
          </select>
        </Field>
        <Field label="Movement">
          <select className="select" value={form.movementPattern} onChange={(event) => setForm({ ...form, movementPattern: event.target.value as MovementPattern })}>
            {PATTERNS.map((pattern) => <option key={pattern}>{pattern}</option>)}
          </select>
        </Field>
        <NumberCell label="Health" value={form.health} min={1} onChange={(value) => setForm({ ...form, health: value })} />
        <NumberCell label="Reward" value={form.reward} min={0} onChange={(value) => setForm({ ...form, reward: value })} />
        <NumberCell label="Speed" value={form.speed} onChange={(value) => setForm({ ...form, speed: value })} />
        <NumberCell label="Size" value={form.size} min={4} onChange={(value) => setForm({ ...form, size: value })} />
        <NumberCell label="Spawn weight" value={form.spawnWeight} step={0.5} onChange={(value) => setForm({ ...form, spawnWeight: value })} />
        <NumberCell label="Min interval (ms)" value={form.minSpawnIntervalMs} step={100} onChange={(value) => setForm({ ...form, minSpawnIntervalMs: value })} />
        <NumberCell label="Palette" value={form.palette} min={0} max={12} onChange={(value) => setForm({ ...form, palette: value })} />
      </div>
      <p className="tiny dim" style={{ marginTop: '0.7rem' }}>
        Expected cost to kill at power 1: <strong className="num">{formatCoins(form.health)}</strong> demo coins, paying{' '}
        <strong className="num">{formatCoins(form.reward)}</strong>. A reward above the health implies a positive return per kill, which
        is fine for a demo but is exactly the number an operator must audit before charging for play.
      </p>
    </Modal>
  );
}
