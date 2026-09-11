import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePlatform } from '../../state/PlatformContext';
import { useToast } from '../../state/toast';
import { AdminState, DemoNote, NumberCell, useResource } from './shared';
import { PublishBar } from './AdminFish';
import { Badge, Button, Field, Modal, Panel, formatCoins } from '../../components/ui';
import type { RoomSummary } from '@reef/shared';

type Draft = { name: string; description: string; minBet: number; maxBet: number; maxPlayers: number; spawnRateMultiplier: number; status: 'ACTIVE' | 'INACTIVE' };
const toDraft = (room: RoomSummary): Draft => ({ name: room.name, description: room.description, minBet: room.minBet, maxBet: room.maxBet, maxPlayers: room.maxPlayers, spawnRateMultiplier: 1, status: room.status });

export function AdminRooms(): JSX.Element {
  const resource = useResource(() => api.admin.rooms(), []);
  const toast = useToast();
  const { reload } = usePlatform();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const items = resource.data?.items ?? [];

  const save = async (room: RoomSummary & { activeRounds: number; sessionsToday: number }): Promise<void> => {
    const draft = drafts[room.id];
    if (!draft) return;
    setSaving(room.id);
    try {
      await api.admin.updateRoom(room.id, {
        name: draft.name,
        description: draft.description,
        minBet: draft.minBet,
        maxBet: draft.maxBet,
        maxPlayers: draft.maxPlayers,
        status: draft.status,
      });
      toast.push(`${draft.name} saved.`, 'success');
      setDrafts((current) => {
        const next = { ...current };
        delete next[room.id];
        return next;
      });
      resource.reload();
      void reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save that room.', 'error');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="col stack-2">
      <p className="small muted" style={{ maxWidth: '70ch', lineHeight: 1.55 }}>
        A room defines the legal bet range per shot, seat capacity and fish density. Deactivating a room closes its live round and
        notifies the players inside it.
      </p>

      <Panel title={`Game rooms · ${items.length}`}>
        <AdminState error={resource.error} loading={resource.loading} empty={!items.length}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {items.map((room) => {
              const draft = drafts[room.id] ?? toDraft(room);
              const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(room));
              return (
                <div className="card card-pad col" key={room.id} style={{ gap: '0.6rem' }}>
                  <div className="row-between">
                    <strong>{room.name}</strong>
                    <div className="row" style={{ gap: '0.35rem' }}>
                      <Badge tone={room.status === 'ACTIVE' ? 'green' : 'red'}>{room.status}</Badge>
                      <Badge>{room.playersInRoom}/{room.maxPlayers} in</Badge>
                    </div>
                  </div>
                  <span className="tiny dim num">{room.key} · {room.sessionsToday} sessions today · {room.activeRounds} active round(s)</span>
                  <Field label="Description">
                    <textarea className="textarea" style={{ minHeight: 60 }} value={draft.description} onChange={(event) => setDrafts((c) => ({ ...c, [room.id]: { ...draft, description: event.target.value } }))} />
                  </Field>
                  <div className="editor-grid">
                    <NumberCell label="Min bet" value={draft.minBet} min={1} onChange={(value) => setDrafts((c) => ({ ...c, [room.id]: { ...draft, minBet: Math.max(1, Math.round(value)) } }))} />
                    <NumberCell label="Max bet" value={draft.maxBet} min={1} onChange={(value) => setDrafts((c) => ({ ...c, [room.id]: { ...draft, maxBet: Math.max(1, Math.round(value)) } }))} />
                    <NumberCell label="Max players" value={draft.maxPlayers} min={1} max={32} onChange={(value) => setDrafts((c) => ({ ...c, [room.id]: { ...draft, maxPlayers: Math.max(1, Math.round(value)) } }))} />
                    <NumberCell label="Spawn ×" value={draft.spawnRateMultiplier} step={0.05} min={0.1} max={5} onChange={(value) => setDrafts((c) => ({ ...c, [room.id]: { ...draft, spawnRateMultiplier: value } }))} />
                  </div>
                  <div className="row-between">
                    <span className="tiny dim">Cannons costing {draft.minBet}–{draft.maxBet} demo coins are legal here.</span>
                    <div className="row" style={{ gap: '0.4rem' }}>
                      <button type="button" className="mini-toggle" data-on={draft.status === 'ACTIVE'} onClick={() => setDrafts((c) => ({ ...c, [room.id]: { ...draft, status: draft.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' } }))}>
                        {draft.status === 'ACTIVE' ? 'OPEN' : 'CLOSED'}
                      </button>
                      <Button size="sm" variant="primary" disabled={!dirty} loading={saving === room.id} onClick={() => void save(room)}>Save</Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </AdminState>
        <div className="row-between" style={{ paddingTop: '0.8rem' }}>
          <DemoNote />
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>+ New room</Button>
        </div>
      </Panel>

      <PublishBar onPublished={() => { resource.reload(); void reload(); }} />

      <NewRoom open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); resource.reload(); void reload(); }} />
    </div>
  );
}

function NewRoom({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const toast = useToast();
  const [form, setForm] = useState({ key: '', name: '', description: '', minBet: 1, maxBet: 10, maxPlayers: 4 });
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title="New game room" onClose={onClose} footer={
      <div className="row" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!form.key || !form.name} onClick={async () => {
          setBusy(true);
          try {
            await api.admin.createRoom({ ...form, status: 'ACTIVE', spawnRateMultiplier: 1 });
            toast.push('Room created.', 'success');
            onCreated();
          } catch (err) {
            toast.push(err instanceof ApiError ? err.message : 'Could not create the room.', 'error');
          } finally {
            setBusy(false);
          }
        }}>Create room</Button>
      </div>
    }>
      <div className="editor-grid">
        <Field label="Key" required><input className="input" value={form.key} onChange={(event) => setForm({ ...form, key: event.target.value })} placeholder="midnight_reef" /></Field>
        <Field label="Name" required><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <NumberCell label="Min bet" value={form.minBet} min={1} onChange={(value) => setForm({ ...form, minBet: value })} />
        <NumberCell label="Max bet" value={form.maxBet} min={1} onChange={(value) => setForm({ ...form, maxBet: value })} />
        <NumberCell label="Max players" value={form.maxPlayers} min={1} max={32} onChange={(value) => setForm({ ...form, maxPlayers: value })} />
      </div>
      <Field label="Description"><input className="input" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
      <p className="tiny dim" style={{ marginTop: '0.6rem' }}>Bets from {formatCoins(form.minBet)} to {formatCoins(form.maxBet)} demo coins per shot.</p>
    </Modal>
  );
}
