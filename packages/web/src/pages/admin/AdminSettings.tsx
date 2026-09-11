import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePlatform } from '../../state/PlatformContext';
import { useToast } from '../../state/toast';
import { NumberCell, useResource } from './shared';
import { PublishBar } from './AdminFish';
import { Badge, Button, Field, Modal, Panel, Toggle } from '../../components/ui';
import type { GameConfiguration } from '@reef/shared';

type Settings = GameConfiguration['settings'];

const DEFAULTS: Settings = {
  maxActiveFish: 45,
  fishSpawnRate: 4.6,
  maxProjectiles: 90,
  roundDurationS: 1800,
  gameSpeed: 1,
  waveIntervalS: 45,
  waveSize: 9,
  minShotValue: 1,
  maxShotValue: 100,
  fishLifetimeS: 28,
  specialFishEnabled: true,
  rtpTarget: 0.9,
};

export function AdminSettings(): JSX.Element {
  const resource = useResource(() => api.admin.settings(), []);
  const toast = useToast();
  const { reload } = usePlatform();
  const [draft, setDraft] = useState<Settings>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<{ version: string; notes: string | null; active: boolean; publishedAt: string; publishedBy: string | null }[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewPayload, setViewPayload] = useState<GameConfiguration | null>(null);

  useEffect(() => {
    if (resource.data) setDraft(resource.data.settings);
    api.admin.versions().then((payload) => setVersions(payload.items)).catch(() => undefined);
  }, [resource.data]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(resource.data?.settings ?? DEFAULTS);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.admin.updateSettings(draft);
      toast.push('Game settings saved. Publish a version to apply them to new rounds.', 'success');
      resource.reload();
      await reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save settings.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col stack-2">
      <p className="small muted" style={{ maxWidth: '74ch', lineHeight: 1.55 }}>
        These are the global simulation parameters. Nothing here is hard-coded in the client: the game fetches them at runtime, and each
        round permanently records the configuration version it ran with so any result can be re-derived later.
      </p>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Panel title="Spawning & density">
          <div className="editor-grid">
            <NumberCell label="Max active fish" value={draft.maxActiveFish} min={1} max={400} onChange={(value) => setDraft({ ...draft, maxActiveFish: value })} />
            <NumberCell label="Fish / second" value={draft.fishSpawnRate} step={0.1} min={0.1} max={40} onChange={(value) => setDraft({ ...draft, fishSpawnRate: value })} />
            <NumberCell label="Max projectiles" value={draft.maxProjectiles} min={5} max={500} onChange={(value) => setDraft({ ...draft, maxProjectiles: value })} />
            <NumberCell label="Fish lifetime (s)" value={draft.fishLifetimeS} min={4} max={600} onChange={(value) => setDraft({ ...draft, fishLifetimeS: value })} />
            <NumberCell label="Wave interval (s)" value={draft.waveIntervalS} min={5} max={3600} onChange={(value) => setDraft({ ...draft, waveIntervalS: value })} />
            <NumberCell label="Wave size" value={draft.waveSize} min={1} max={60} onChange={(value) => setDraft({ ...draft, waveSize: value })} />
          </div>
          <div className="row-between" style={{ marginTop: '0.9rem' }}>
            <div>
              <strong>Special fish & bosses</strong>
              <div className="tiny dim">Include golden, treasure, speed, bomb and boss spawns</div>
            </div>
            <Toggle on={draft.specialFishEnabled} label="Special fish" onChange={(value) => setDraft({ ...draft, specialFishEnabled: value })} />
          </div>
        </Panel>

        <Panel title="Round & betting">
          <div className="editor-grid">
            <NumberCell label="Round duration (s)" value={draft.roundDurationS} min={30} max={86400} onChange={(value) => setDraft({ ...draft, roundDurationS: value })} />
            <NumberCell label="Min shot value" value={draft.minShotValue} min={1} onChange={(value) => setDraft({ ...draft, minShotValue: value })} />
            <NumberCell label="Max shot value" value={draft.maxShotValue} min={1} onChange={(value) => setDraft({ ...draft, maxShotValue: value })} />
            <NumberCell label="Game speed ×" value={draft.gameSpeed} step={0.05} min={0.2} max={4} onChange={(value) => setDraft({ ...draft, gameSpeed: value })} />
            <NumberCell label="RTP target" value={draft.rtpTarget} step={0.01} min={0.01} max={1} onChange={(value) => setDraft({ ...draft, rtpTarget: value })} />
          </div>
          <p className="tiny dim" style={{ marginTop: '0.8rem', lineHeight: 1.55 }}>
            The RTP target is a reporting benchmark only. It is never applied to an individual player: outcomes depend on aim, fish
            selection and the shared spawn sequence — never on who you are, what you have or how the last round went.
          </p>
          <div className="row-between" style={{ marginTop: '0.9rem' }}>
            <Badge tone={dirty ? 'gold' : 'green'}>{dirty ? 'Unsaved changes' : 'Saved values'}</Badge>
            <div className="row" style={{ gap: '0.4rem' }}>
              <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(resource.data?.settings ?? DEFAULTS)}>Revert</Button>
              <Button size="sm" variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>Save settings</Button>
            </div>
          </div>
        </Panel>
      </div>

      <PublishBar onPublished={() => { resource.reload(); api.admin.versions().then((payload) => setVersions(payload.items)).catch(() => undefined); }} />

      <Panel title="Configuration history" pad={false}>
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="data">
            <thead><tr><th>Version</th><th>Published</th><th>By</th><th>State</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.version}>
                  <td className="num"><strong>{version.version}</strong></td>
                  <td className="tiny dim">{new Date(version.publishedAt).toLocaleString()}</td>
                  <td className="tiny">{version.publishedBy ?? 'system'}</td>
                  <td>{version.active ? <Badge tone="green">active</Badge> : <Badge>archived</Badge>}</td>
                  <td className="tiny muted">{version.notes ?? '—'}</td>
                  <td className="actions">
                    <Button size="sm" variant="ghost" onClick={async () => {
                      setViewing(version.version);
                      setViewPayload(null);
                      try {
                        const payload = await api.admin.version(version.version);
                        setViewPayload(payload.config);
                      } catch (err) {
                        toast.push(err instanceof ApiError ? err.message : 'Could not load that version.', 'error');
                        setViewing(null);
                      }
                    }}>Inspect</Button>
                  </td>
                </tr>
              ))}
              {!versions.length ? <tr><td colSpan={6} className="tiny dim">No published versions yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Panel>

      {viewing ? (
        <Modal open title={`Configuration snapshot ${viewing}`} onClose={() => setViewing(null)} wide>
          {!viewPayload ? <p className="tiny dim">Loading snapshot…</p> : (
            <div className="col stack-1">
              <div className="editor-grid">
                <Field label="Settings"><pre className="audit-diff">{JSON.stringify(viewPayload.settings, null, 1)}</pre></Field>
              </div>
              <Panel title="Fish table used by rounds on this version" pad={false}>
                <div className="table-wrap" style={{ border: 0, maxHeight: 320 }}>
                  <table className="data">
                    <thead><tr><th>Species</th><th className="right">Health</th><th className="right">Reward</th><th className="right">Speed</th><th className="right">Weight</th><th>Movement</th></tr></thead>
                    <tbody>
                      {viewPayload.fish.map((fish) => (
                        <tr key={fish.key}>
                          <td>{fish.name}</td>
                          <td className="right num">{fish.health}</td>
                          <td className="right num">{fish.reward}</td>
                          <td className="right num">{fish.speed}</td>
                          <td className="right num">{fish.spawnWeight}</td>
                          <td className="tiny dim">{fish.movementPattern}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
