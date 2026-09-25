import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import { Badge, Button, Empty, Modal, Panel, Skeleton, formatCoins } from '../components/ui';
import type { TournamentDetail, TournamentSummary } from '@reef/shared';

/**
 * Tournament lobby. Fixed-size, fixed-duration matches: every seat pays the
 * entry fee into the prize pool, everybody fires the same cannon with free
 * shots, and the highest score takes the pool minus the operator's rake.
 */

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function countdown(targetIso: string | null, now: number): string {
  if (!targetIso) return '—';
  const ms = Math.max(0, Date.parse(targetIso) - now);
  const totalS = Math.ceil(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const STATUS_TONE: Record<string, 'gold' | 'green' | 'red' | 'cyan'> = {
  LOBBY: 'gold',
  RUNNING: 'green',
  SETTLED: 'cyan',
  CANCELLED: 'red',
};

export function Tournaments(): JSX.Element {
  const navigate = useNavigate();
  const { wallet, refreshMe } = useAuth();
  const now = useNow(1000);
  const [items, setItems] = useState<TournamentSummary[] | null>(null);
  const [mine, setMine] = useState<TournamentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.tournaments(), api.myTournaments()])
      .then(([open, entered]) => {
        setItems(open.items);
        setMine(entered.items);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Tournament list unavailable.'));
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const lobbies = useMemo(() => (items ?? []).filter((t) => t.status === 'LOBBY'), [items]);
  const live = useMemo(() => (items ?? []).filter((t) => t.status === 'RUNNING'), [items]);

  const join = async (tournament: TournamentSummary): Promise<void> => {
    setBusy(tournament.id);
    try {
      const result = await api.joinTournament(tournament.id);
      await refreshMe();
      load();
      if (result.started) navigate(`/play/tournament/${tournament.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that tournament.');
    } finally {
      setBusy(null);
    }
  };

  const leave = async (tournament: TournamentSummary): Promise<void> => {
    setBusy(tournament.id);
    try {
      await api.leaveTournament(tournament.id);
      await refreshMe();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave that tournament.');
    } finally {
      setBusy(null);
    }
  };

  const balance = wallet?.balance ?? 0;

  return (
    <div style={{ width: 'min(1240px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Tournaments</h1>
          <p className="sub">Pay the entry fee, out-shoot the room, take the pot. Every player fires the same cannon with free shots.</p>
        </div>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <Badge tone="gold">Balance {formatCoins(balance)} demo coins</Badge>
        </div>
      </div>

      {error ? (
        <div className="notice-box danger small" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      ) : null}

      {items === null ? (
        <div className="room-grid">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} height={250} />
          ))}
        </div>
      ) : (
        <>
          <TournamentSection
            title="Starting soon"
            empty="No open lobbies right now. Check back shortly — new matches open regularly."
            tournaments={lobbies}
            now={now}
            balance={balance}
            busy={busy}
            onJoin={(t) => void join(t)}
            onLeave={(t) => void leave(t)}
            onEnter={(t) => navigate(`/play/tournament/${t.id}`)}
            onDetail={setDetailId}
          />
          <TournamentSection
            title="Live now"
            empty="No matches running at the moment."
            tournaments={live}
            now={now}
            balance={balance}
            busy={busy}
            onJoin={(t) => void join(t)}
            onLeave={(t) => void leave(t)}
            onEnter={(t) => navigate(`/play/tournament/${t.id}`)}
            onDetail={setDetailId}
          />
          <Panel title={`My tournaments · ${(mine ?? []).length}`} className="stack-1">
            {mine === null ? (
              <Skeleton height={80} />
            ) : mine.length === 0 ? (
              <Empty icon="🏆" title="No entries yet" body="Join a lobby above — your matches and results will appear here." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tournament</th>
                      <th>Status</th>
                      <th className="num">Entry</th>
                      <th className="num">Score</th>
                      <th className="num">Rank</th>
                      <th className="num">Prize</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <strong>{t.name}</strong>
                          <div className="tiny dim">
                            {t.seatsTaken}/{t.maxPlayers} players · {t.durationS}s
                          </div>
                        </td>
                        <td>
                          <Badge tone={STATUS_TONE[t.status] ?? 'cyan'}>{t.status}</Badge>
                        </td>
                        <td className="num">{formatCoins(t.entryFee)}</td>
                        <td className="num">{t.myEntry ? formatCoins(t.myEntry.score) : '—'}</td>
                        <td className="num">{t.myEntry?.rank ? `#${t.myEntry.rank}` : '—'}</td>
                        <td className="num" style={{ color: (t.myEntry?.prize ?? 0) > 0 ? 'var(--aqua)' : undefined }}>
                          {(t.myEntry?.prize ?? 0) > 0 ? `+${formatCoins(t.myEntry!.prize)}` : '—'}
                        </td>
                        <td className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end' }}>
                          {t.status === 'RUNNING' ? (
                            <Button size="sm" variant="primary" onClick={() => navigate(`/play/tournament/${t.id}`)}>
                              Enter arena
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => setDetailId(t.id)}>
                            Standings
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      <Panel title="How tournaments work" className="stack-1">
        <p className="small muted" style={{ lineHeight: 1.6 }}>
          Your <strong>entry fee goes into the prize pool</strong> — it is not spent on shots. Inside the arena every shot is free and
          every player fires the same cannon, so the entry fee is the only stake and the steadiest aim wins. When time runs out the
          highest score takes the pool minus the operator's rake shown on each card (ties break by kills, then by fewest shots). Leave a
          lobby any time for a full refund; once the match starts, entries are locked.
        </p>
      </Panel>

      <TournamentDetailModal id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function TournamentSection(props: {
  title: string;
  empty: string;
  tournaments: TournamentSummary[];
  now: number;
  balance: number;
  busy: string | null;
  onJoin: (t: TournamentSummary) => void;
  onLeave: (t: TournamentSummary) => void;
  onEnter: (t: TournamentSummary) => void;
  onDetail: (id: string) => void;
}): JSX.Element {
  const { title, empty, tournaments, now, balance, busy, onJoin, onLeave, onEnter, onDetail } = props;
  return (
    <section className="stack-1">
      <h2 style={{ fontSize: '1.15rem', marginBottom: '0.7rem' }}>
        {title} · {tournaments.length}
      </h2>
      {tournaments.length === 0 ? (
        <Panel>
          <Empty icon="🏆" title={title} body={empty} />
        </Panel>
      ) : (
        <div className="room-grid">
          {tournaments.map((t) => {
            const entered = !!t.myEntry;
            const full = t.seatsTaken >= t.maxPlayers;
            const tooPoor = balance < t.entryFee;
            const winnerShare = 100 - t.rakePct;
            const prizeNow = Math.floor((t.prizePool * winnerShare) / 100);
            return (
              <article className="room-tile" key={t.id} data-locked={t.status === 'RUNNING' && !entered}>
                <span className="water" aria-hidden="true" />
                <div className="row-between" style={{ gap: '0.5rem' }}>
                  <Badge tone={STATUS_TONE[t.status] ?? 'cyan'}>{t.status === 'LOBBY' ? `Lobby · closes in ${countdown(t.lobbyEndsAt, now)}` : `Live · ${countdown(t.endsAt, now)} left`}</Badge>
                  <span className="seat-dots" aria-label={`${t.seatsTaken} of ${t.maxPlayers} seats taken`}>
                    {Array.from({ length: t.maxPlayers }).map((_, seat) => (
                      <i key={seat} data-taken={seat < t.seatsTaken} />
                    ))}
                  </span>
                </div>
                <h3>{t.name}</h3>
                <div className="row wrap" style={{ gap: '0.35rem' }}>
                  <span className="badge badge-gold num">Entry {formatCoins(t.entryFee)}</span>
                  <span className="badge num">
                    {t.seatsTaken}/{t.maxPlayers} players
                  </span>
                  <span className="badge badge-cyan num">Pool {formatCoins(t.prizePool)}</span>
                </div>
                <div className="tiny dim" style={{ lineHeight: 1.6 }}>
                  {t.cannonName} · {t.durationS}s match · winner takes {winnerShare}% (rake {t.rakePct}%)
                  <br />
                  Winner prize right now: <strong style={{ color: 'var(--sun)' }}>{formatCoins(prizeNow)} demo coins</strong>
                </div>
                <div style={{ marginTop: 'auto', paddingTop: '0.7rem' }} className="col">
                  {t.status === 'LOBBY' && !entered ? (
                    <div className="col" style={{ gap: '0.4rem' }}>
                      {tooPoor ? (
                        <span className="tiny" style={{ color: 'var(--coral)', fontWeight: 700 }}>
                          You need {formatCoins(t.entryFee)} demo coins to enter
                        </span>
                      ) : null}
                      <Button variant="primary" block loading={busy === t.id} disabled={full || tooPoor} onClick={() => onJoin(t)}>
                        {full ? 'Lobby full' : `Join · ${formatCoins(t.entryFee)}`}
                      </Button>
                    </div>
                  ) : null}
                  {t.status === 'LOBBY' && entered ? (
                    <div className="col" style={{ gap: '0.4rem' }}>
                      <span className="tiny" style={{ color: 'var(--aqua)', fontWeight: 700 }}>
                        Seat secured — the match starts when the lobby fills.
                      </span>
                      <Button size="sm" variant="ghost" loading={busy === t.id} onClick={() => onLeave(t)}>
                        Leave & refund {formatCoins(t.entryFee)}
                      </Button>
                    </div>
                  ) : null}
                  {t.status === 'RUNNING' && entered ? (
                    <Button variant="primary" block onClick={() => onEnter(t)}>
                      Enter arena
                    </Button>
                  ) : null}
                  {t.status === 'RUNNING' && !entered ? (
                    <span className="tiny" style={{ color: 'var(--coral)', fontWeight: 700 }}>
                      Match in progress — entries are locked.
                    </span>
                  ) : null}
                  <button type="button" className="link tiny" style={{ marginTop: '0.35rem' }} onClick={() => onDetail(t.id)}>
                    View standings & prize split
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TournamentDetailModal({ id, onClose }: { id: string | null; onClose: () => void }): JSX.Element | null {
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api
        .tournament(id)
        .then((data) => {
          if (!cancelled) {
            setDetail(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the tournament.');
        });
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id]);

  return (
    <Modal open={id !== null} title={detail ? detail.name : 'Tournament'} onClose={onClose}>
      {error ? (
        <div className="notice-box danger small">{error}</div>
      ) : !detail ? (
        <Skeleton height={180} />
      ) : (
        <div className="col" style={{ gap: '0.8rem' }}>
          <div className="row wrap" style={{ gap: '0.4rem' }}>
            <Badge tone={STATUS_TONE[detail.status] ?? 'cyan'}>{detail.status}</Badge>
            <span className="badge num">Entry {formatCoins(detail.entryFee)}</span>
            <span className="badge badge-cyan num">Pool {formatCoins(detail.prizePool)}</span>
            <span className="badge num">Rake {detail.rakePct}%</span>
          </div>
          {detail.status === 'SETTLED' ? (
            <div className="notice-box info small">
              Winner <strong>{detail.winnerUsername ?? '—'}</strong> took{' '}
              <strong>{formatCoins(detail.prizePool - detail.rakeAmount)} demo coins</strong>; operator rake{' '}
              <strong>{formatCoins(detail.rakeAmount)}</strong>.
            </div>
          ) : (
            <p className="tiny dim" style={{ margin: 0 }}>
              Winner takes {100 - detail.rakePct}% of the pool — currently{' '}
              <strong>{formatCoins(Math.floor((detail.prizePool * (100 - detail.rakePct)) / 100))} demo coins</strong>.
            </p>
          )}
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
                  <tr key={entry.userId} style={entry.me ? { background: 'rgba(36, 215, 255, 0.08)' } : undefined}>
                    <td className="num">{entry.rank ?? '—'}</td>
                    <td>
                      {entry.me ? <strong>{entry.username} (you)</strong> : entry.username}
                    </td>
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
          {detail.myEntry && detail.status === 'SETTLED' ? (
            <p className="small" style={{ margin: 0 }}>
              {detail.winnerUsername && detail.myEntry.rank === 1
                ? `You won ${formatCoins(detail.myEntry.prize)} demo coins. Congratulations!`
                : `You finished #${detail.myEntry.rank} with ${formatCoins(detail.myEntry.score)} points.`}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

export function tournamentJoinErrorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Could not join that tournament.';
}
