import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import { usePlatform } from '../state/PlatformContext';
import { api, type SessionSummary } from '../lib/api';
import { Badge, Button, Empty, Panel, Skeleton, Stat, formatCoins, formatSigned, timeAgo } from '../components/ui';
import { FishAvatarSprite } from '../components/previews';
import { LeaderboardTable } from '../components/LeaderboardTable';
import type { GameHistoryEntry } from '@reef/shared';

/**
 * Player dashboard: balance, quick play, recent results and the leaderboard.
 * Every number is read from the API — the client never computes a balance.
 */
export function Dashboard(): JSX.Element {
  const { user, wallet, loading, securityNotice, dismissSecurityNotice } = useAuth();
  const { config, meta } = usePlatform();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [history, setHistory] = useState<GameHistoryEntry[] | null>(null);
  const [totals, setTotals] = useState<{ wagered: number; rewarded: number; rounds: number; net: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([api.gameSessions(), api.history({ limit: 8 }), api.me()])
      .then(([sessionPayload, historyPayload, me]) => {
        if (!alive) return;
        setSessions(sessionPayload.items);
        setHistory(historyPayload.items);
        setTotals(me.totals);
      })
      .catch(() => {
        if (!alive) return;
        setSessions([]);
        setHistory([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const rooms = config?.rooms ?? [];
  const nextRoom = useMemo(() => {
    if (!rooms.length) return null;
    const balance = wallet?.balance ?? 0;
    return [...rooms].reverse().find((room) => room.minBet <= balance) ?? rooms[0];
  }, [rooms, wallet?.balance]);

  const recentResults = (history ?? []).slice(0, 6);

  return (
    <div className="container-tight" style={{ width: 'min(1240px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="row-between wrap" style={{ alignItems: 'flex-end', marginBottom: '1.1rem' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(1.5rem,3.4vw,2.1rem)' }}>Welcome back, {user?.username}</h1>
          <p className="muted small" style={{ marginTop: '0.35rem' }}>
            {meta?.maintenance ? 'Maintenance is active — rooms are temporarily closed.' : 'The reef is live. Pick a room and start shooting.'}
          </p>
        </div>
        <div className="row wrap" style={{ gap: '0.5rem' }}>
          <Badge tone="gold">18+ · demo currency</Badge>
          <Badge tone={meta?.flags.realMoneyEnabled ? 'red' : 'green'}>Real money: {meta?.flags.realMoneyEnabled ? 'enabled' : 'disabled'}</Badge>
        </div>
      </div>

      {securityNotice ? (
        <div className="notice-box" role="status" style={{ marginBottom: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.9rem', flexWrap: 'wrap' }}>
          <span className="small">{securityNotice}</span>
          <span className="row" style={{ gap: '0.5rem' }}>
            <Button size="sm" variant="ghost" onClick={() => { dismissSecurityNotice(); navigate('/settings'); }}>
              Review security settings
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissSecurityNotice}>
              Dismiss
            </Button>
          </span>
        </div>
      ) : null}

      <div className="dash-hero card">
        <div className="dash-balance">
          <span className="k upper">Demo coins</span>
          {loading && !wallet ? (
            <Skeleton height={54} width="60%" />
          ) : (
            <span className="v num" key={wallet?.balance}>
              {formatCoins(wallet?.balance ?? 0)}
            </span>
          )}
          <span className="tiny dim">Virtual currency · no cash value · cannot be withdrawn</span>
          <div className="row wrap" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button variant="primary" size="lg" onClick={() => navigate('/play')}>
              ▶ Play now
            </Button>
            <Button variant="ghost" onClick={() => navigate('/wallet')}>
              Add demo coins
            </Button>
          </div>
        </div>

        <div className="dash-stats">
          <Stat label="Lifetime wagered" value={formatCoins(totals?.wagered ?? 0)} tone="cyan" hint="Demo coins spent on shots" />
          <Stat label="Lifetime rewarded" value={formatCoins(totals?.rewarded ?? 0)} tone="gold" hint="Demo coins won from fish" />
          <Stat
            label="Net demo result"
            value={totals ? formatSigned(totals.net) : '—'}
            tone={(totals?.net ?? 0) >= 0 ? 'green' : 'red'}
            hint={`${totals?.rounds ?? 0} rounds played`}
          />
        </div>
      </div>

      <div className="dash-grid">
        <Panel title="Game rooms" actions={<Link to="/play" className="tiny muted">See all →</Link>}>
          <div className="col" style={{ gap: '0.55rem' }}>
            {rooms.length === 0 ? <Skeleton height={70} /> : null}
            {rooms.map((room) => {
              const affordable = (wallet?.balance ?? 0) >= room.minBet;
              return (
                <button
                  key={room.key}
                  className={`room-row ${nextRoom?.key === room.key ? 'suggested' : ''}`}
                  onClick={() => navigate(`/play/${room.key}`)}
                  disabled={!affordable}
                  title={affordable ? `Open ${room.name}` : `You need at least ${room.minBet} demo coins for this room`}
                >
                  <span className="tag num">{room.minBet}+</span>
                  <span className="grow col" style={{ gap: 1, textAlign: 'left' }}>
                    <strong>{room.name}</strong>
                    <span className="tiny dim">
                      Bet {room.minBet}–{room.maxBet} demo coins · {room.maxPlayers} seats
                    </span>
                  </span>
                  <span className="tiny" style={{ color: affordable ? 'var(--cyan)' : 'var(--coral)' }}>
                    {affordable ? 'Enter →' : 'Insufficient'}
                  </span>
                </button>
              );
            })}
            {!rooms.length ? <Empty title="No rooms configured" body="An administrator has not published any game rooms yet." /> : null}
          </div>
        </Panel>

        <Panel title="Recent games" actions={<Link to="/history" className="tiny muted">Full history →</Link>} pad={false}>
          {sessions === null ? (
            <div style={{ padding: '1rem' }} className="col">
              <Skeleton height={34} />
              <Skeleton height={34} />
              <Skeleton height={34} />
            </div>
          ) : sessions.length === 0 ? (
            <Empty title="No rounds yet" body="Your completed sessions will appear here with bets, rewards and net result." action={<Button size="sm" onClick={() => navigate('/play')}>Play first round</Button>} />
          ) : (
            <ul className="session-list">
              {sessions.slice(0, 6).map((session) => (
                <li key={session.sessionId}>
                  <span className="col" style={{ gap: 1 }}>
                    <strong>{session.roomName}</strong>
                    <span className="tiny dim">
                      {session.shots} shots · {session.kills} kills · {timeAgo(session.startedAt)} · cfg {session.configVersion}
                    </span>
                  </span>
                  <span className="col" style={{ gap: 1, alignItems: 'flex-end' }}>
                    <span className={`num ${session.net >= 0 ? 'pos' : 'neg'}`}>{formatSigned(session.net)}</span>
                    <span className="tiny dim">
                      {formatCoins(session.rewarded)} won / {formatCoins(session.wagered)} bet
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Latest catches" pad={false}>
          {history === null ? (
            <div style={{ padding: '1rem' }} className="col">
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : recentResults.length === 0 ? (
            <Empty title="Nothing caught yet" body="Defeat a fish and it will show up here instantly." />
          ) : (
            <ul className="catch-list">
              {recentResults.map((entry) => (
                <li key={entry.id}>
                  <FishAvatarSprite species={config?.fish.find((f) => f.key === entry.fishKey) ?? null} size={46} />
                  <span className="grow col" style={{ gap: 1 }}>
                    <strong>{entry.fishName ?? (entry.result === 'MISSED' ? 'Missed shot' : entry.fishKey ?? 'Hit')}</strong>
                    <span className="tiny dim">
                      {entry.roomName} · {entry.result.toLowerCase()} · cost {entry.shotCost}
                    </span>
                  </span>
                  <span className={`num ${entry.reward > 0 ? 'pos' : 'dim'}`}>{entry.reward > 0 ? `+${entry.reward}` : '0'}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Leaderboard · today" actions={<Link to="/leaderboard" className="tiny muted">Full board →</Link>} pad={false}>
          <LeaderboardWindowToday />
        </Panel>
      </div>
    </div>
  );
}

function LeaderboardWindowToday(): JSX.Element {
  return <LeaderboardTable window="daily" compact />;
}
