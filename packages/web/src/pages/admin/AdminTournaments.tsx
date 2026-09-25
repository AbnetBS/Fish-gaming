import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePlatform } from '../../state/PlatformContext';
import { useToast } from '../../state/toast';
import { AdminState, DemoNote, NumberCell, useResource } from './shared';
import { Badge, Button, Field, Modal, Panel, formatCoins } from '../../components/ui';
import type { TournamentDetail, TournamentSummary } from '@reef/shared';

const STATUS_TONE: Record<string, 'gold' | 'green' | 'red' | 'cyan'> = {
  LOBBY: 'gold',
  RUNNING: 'green',
  SETTLED: 'cyan',
  CANCELLED: 'red',
};

/**
 * Tournament operations: create entry-fee matches, watch lobbies fill, start
 * early or cancel with refunds, and track the accumulated operator rake.
 */
export function AdminTournaments(): JSX.Element {
  const [status, setStatus] = useState('ALL');
  const resource = useResource(() => api.admin.tournaments(status === 'ALL' ? undefined : status), [status]);
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = resource.data?.items ?? [];
  const house = resource.data?.house;

  const act = async (kind: 'start' | 'cancel', tournament: TournamentSummary): Promise<void> => {
    if (kind === 'cancel' && tournament.seatsTaken > 0) {
      const confirmed = window.confirm(
        `Cancel "${tournament.name}" and refund ${tournament.seatsTaken} entrant(s) ${formatCoins(tournament.prizePool)} demo coins?`,
      );
      if (!confirmed) return;
    }
    setBusy(`${kind}:${tournament.id}`);
    try {
      if (kind === 'start') await api.admin.startTournament(tournament.id);
      else await api.admin.cancelTournament(tournament.id, 'Cancelled by operator.');
      toast.push(kind === 'start' ? 'Tournament started.' : 'Tournament cancelled — entries refunded.', 'success');
      resource.reload();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'That action failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col stack-2">
      <p className="small muted" style={{ maxWidth: '70ch', lineHeight: 1.55 }}>
        Each tournament is a fixed-size match: seats pay the entry fee into the prize pool, everybody plays with free shots and one
        fixed cannon, and the highest score takes the pool minus your rake. Lobbies start automatically when full, or when the lobby
        timer expires with enough seats (otherwise everybody is refunded).
      </p>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.7rem' }}>
        <div className="stat-tile">
          <div className="k">Matches settled</div>
          <div className="v">{house ? formatCoins(house.settled) : '—'}</div>
        </div>
        <div className="stat-tile">
          <div className="k">Rake earned (settled)</div>
          <div className="v" style={{ color: 'var(--sun)' }}>{house ? `${formatCoins(house.rake)} ◈` : '—'}</div>
        </div>
        <div className="stat-tile">
          <div className="k">Open prize pools</div>
          <div className="v" style={{ color: 'var(--aqua)' }}>
            {formatCoins(items.filter((t) => t.status === 'LOBBY' || t.status === 'RUNNING').reduce((sum, t) => sum + t.prizePool, 0))} ◈
          </div>
        </div>
      </div>

      <Panel title={`Tournaments · ${items.length}`}>
        <div className="row wrap" style={{ gap: '0.4rem', marginBottom: '0.8rem' }}>
          {['ALL', 'LOBBY', 'RUNNING', 'SETTLED', 'CANCELLED'].map((option) => (
            <button
              key={option}
              type="button"
              className="mini-toggle"
              data-on={status === option}
              onClick={() => setStatus(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <AdminState error={resource.error} loading={resource.loading} empty={!items.length}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tournament</th>
                  <th>Status</th>
                  <th className="num">Entry</th>
                  <th className="num">Seats</th>
                  <th className="num">Pool</th>
                  <th className="num">Rake</th>
                  <th>Winner</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="tiny dim">
                        {t.cannonName} · {t.durationS}s · min {t.minPlayers}
                      </div>
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[t.status] ?? 'cyan'}>{t.status}</Badge>
                    </td>
                    <td className="num">{formatCoins(t.entryFee)}</td>
                    <td className="num">
                      {t.seatsTaken}/{t.maxPlayers}
                    </td>
                    <td className="num">{formatCoins(t.prizePool)}</td>
                    <td className="num">{t.rakePct}%</td>
                    <td>{t.winnerUsername ?? '—'}</td>
                    <td className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end' }}>
                      {t.status === 'LOBBY' && t.seatsTaken >= t.minPlayers ? (
                        <Button size="sm" variant="primary" loading={busy === `start:${t.id}`} onClick={() => void act('start', t)}>
                          Start now
                        </Button>
                      ) : null}
                      {t.status === 'LOBBY' ? (
                        <Button size="sm" variant="danger" loading={busy === `cancel:${t.id}`} onClick={() => void act('cancel', t)}>
                          Cancel
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setDetailId(t.id)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminState>
        <div className="row-between" style={{ paddingTop: '0.8rem' }}>
          <DemoNote />
          <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
            + New tournament
          </Button>
        </div>
      </Panel>

      <NewTournament open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); resource.reload(); }} />
      <AdminTournamentDetail id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function NewTournament({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }): JSX.Element {
  const toast = useToast();
  const { config } = usePlatform();
  const cannons = config?.cannons.filter((c) => c.enabled) ?? [];
  const [form, setForm] = useState({
    name: '',
    entryFee: 100,
    minPlayers: 2,
    maxPlayers: 4,
    durationS: 300,
    rakePct: 20,
    cannonKey: 'reef_breaker',
    lobbyMinutes: 15,
  });
  const [busy, setBusy] = useState(false);

  const maxPool = form.entryFee * form.maxPlayers;
  const maxPrize = Math.floor((maxPool * (100 - form.rakePct)) / 100);
  const maxRake = maxPool - maxPrize;

  return (
    <Modal
      open={open}
      title="New tournament"
      onClose={onClose}
      wide
      footer={
        <div className="row" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={form.name.trim().length < 3 || !form.cannonKey}
            onClick={async () => {
              setBusy(true);
              try {
                await api.admin.createTournament({ ...form, name: form.name.trim() });
                toast.push('Tournament created — the lobby is open.', 'success');
                onCreated();
              } catch (err) {
                toast.push(err instanceof ApiError ? err.message : 'Could not create the tournament.', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Create tournament
          </Button>
        </div>
      }
    >
      <div className="editor-grid">
        <Field label="Name" required>
          <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Friday Night Deep Hunt" />
        </Field>
        <Field label="Match cannon (fixed for every player)" required>
          <select className="input" value={form.cannonKey} onChange={(event) => setForm({ ...form, cannonKey: event.target.value })}>
            {cannons.map((cannon) => (
              <option key={cannon.key} value={cannon.key}>
                {cannon.name} · power {cannon.power} · {cannon.fireRate}/s
              </option>
            ))}
          </select>
        </Field>
        <NumberCell label="Entry fee (demo coins)" value={form.entryFee} min={1} max={1000000} onChange={(value) => setForm({ ...form, entryFee: Math.max(1, Math.round(value)) })} />
        <NumberCell label="Min players" value={form.minPlayers} min={2} max={8} onChange={(value) => setForm({ ...form, minPlayers: Math.min(8, Math.max(2, Math.round(value))) })} />
        <NumberCell label="Max players" value={form.maxPlayers} min={2} max={8} onChange={(value) => setForm({ ...form, maxPlayers: Math.min(8, Math.max(2, Math.round(value))) })} />
        <NumberCell label="Match length (seconds)" value={form.durationS} min={60} max={3600} onChange={(value) => setForm({ ...form, durationS: Math.min(3600, Math.max(60, Math.round(value))) })} />
        <NumberCell label="Your rake (%)" value={form.rakePct} min={0} max={90} onChange={(value) => setForm({ ...form, rakePct: Math.min(90, Math.max(0, Math.round(value))) })} />
        <NumberCell label="Lobby open (minutes)" value={form.lobbyMinutes} min={1} max={180} onChange={(value) => setForm({ ...form, lobbyMinutes: Math.min(180, Math.max(1, Math.round(value))) })} />
      </div>
      <div className="notice-box info small" style={{ marginTop: '0.8rem' }}>
        Full lobby: pool <strong>{formatCoins(maxPool)}</strong> → winner <strong>{formatCoins(maxPrize)}</strong> · your rake{' '}
        <strong>{formatCoins(maxRake)}</strong>.
      </div>
    </Modal>
  );
}

function AdminTournamentDetail({ id, onClose }: { id: string | null; onClose: () => void }): JSX.Element {
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    api
      .admin.tournament(id)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the tournament.');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <Modal open={id !== null} title={detail ? detail.name : 'Tournament'} onClose={onClose} wide>
      {error ? (
        <div className="notice-box danger small">{error}</div>
      ) : !detail ? (
        <p className="small muted">Loading…</p>
      ) : (
        <div className="col" style={{ gap: '0.8rem' }}>
          <div className="row wrap" style={{ gap: '0.4rem' }}>
            <Badge tone={STATUS_TONE[detail.status] ?? 'cyan'}>{detail.status}</Badge>
            <span className="badge num">Entry {formatCoins(detail.entryFee)}</span>
            <span className="badge badge-cyan num">Pool {formatCoins(detail.prizePool)}</span>
            <span className="badge num">Rake {detail.rakePct}% ({formatCoins(detail.rakeAmount)} banked)</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th className="num">Score</th>
                  <th className="num">Kills</th>
                  <th className="num">Shots</th>
                  <th className="num">Prize</th>
                </tr>
              </thead>
              <tbody>
                {detail.standings.map((entry) => (
                  <tr key={entry.userId}>
                    <td className="num">{entry.rank ?? '—'}</td>
                    <td>{entry.username}</td>
                    <td className="num">{formatCoins(entry.score)}</td>
                    <td className="num">{entry.kills}</td>
                    <td className="num">{entry.shots}</td>
                    <td className="num" style={{ color: entry.prize > 0 ? 'var(--aqua)' : undefined }}>
                      {entry.prize > 0 ? `+${formatCoins(entry.prize)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
