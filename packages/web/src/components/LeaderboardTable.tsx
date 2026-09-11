import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Avatar, Empty, Skeleton, formatCoins } from './ui';
import { useAuth } from '../state/AuthContext';
import type { LeaderboardEntry, LeaderboardWindow } from '@reef/shared';

const TITLES: Record<LeaderboardWindow, string> = {
  daily: 'Today',
  weekly: 'This week',
  alltime: 'All time',
};

export function LeaderboardTable({ window, compact = false }: { window: LeaderboardWindow; compact?: boolean }): JSX.Element {
  const [items, setItems] = useState<LeaderboardEntry[] | null>(null);
  const [me, setMe] = useState<{ rank: number | null; earned: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .leaderboard(window, compact ? 8 : 25)
      .then((payload) => {
        if (!alive) return;
        setItems(payload.items);
        setMe(payload.me);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : 'Leaderboard unavailable.'));
    return () => {
      alive = false;
    };
  }, [window, compact]);

  if (error) return <Empty icon="⚠" title="Leaderboard unavailable" body={error} />;
  if (items === null)
    return (
      <div className="col" style={{ padding: compact ? '0.75rem 1rem' : '1rem 1.1rem', gap: '0.55rem' }}>
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} height={compact ? 30 : 42} />
        ))}
      </div>
    );

  if (!items.length)
    return <Empty icon="🏆" title="No entries yet" body="Defeat fish to earn demo coins and appear on this board. Only public figures are shown." />;

  const top = items[0]?.earned || 1;

  return (
    <div className={`lb ${compact ? 'lb-compact' : ''}`}>
      <div className="lb-head">
        <span className="rank">#</span>
        <span>Player</span>
        <span className="right">Demo coins earned</span>
        {!compact ? <span className="right">Rounds</span> : null}
      </div>
      {items.map((entry) => {
        const isMe = entry.username === user?.username;
        return (
          <div className={`lb-row ${isMe ? 'me' : ''}`} key={entry.username}>
            <span className={`rank rank-${entry.rank <= 3 ? entry.rank : 'x'}`}>{entry.rank}</span>
            <span className="player">
              <Avatar seed={entry.avatarSeed} name={entry.username} size={compact ? 24 : 30} />
              <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.username}
              </span>
            </span>
            <span className="right num amount">
              {formatCoins(entry.earned)}
              <span className="bar" style={{ width: `${Math.max(3, Math.round((entry.earned / top) * 100))}%` }} aria-hidden="true" />
            </span>
            {!compact ? <span className="right num dim">{entry.rounds}</span> : null}
          </div>
        );
      })}
      {me && me.rank === null ? (
        <div className="lb-foot tiny dim">
          You have earned {formatCoins(me.earned)} demo coins in {TITLES[window].toLowerCase()} but are not yet in the displayed range.
        </div>
      ) : null}
    </div>
  );
}
