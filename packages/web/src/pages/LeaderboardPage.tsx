import { useState } from 'react';
import { LeaderboardTable } from '../components/LeaderboardTable';
import { Panel } from '../components/ui';
import type { LeaderboardWindow } from '@reef/shared';

const TABS: { id: LeaderboardWindow; label: string; hint: string }[] = [
  { id: 'daily', label: 'Today', hint: 'Demo coins won since 00:00 UTC' },
  { id: 'weekly', label: 'This week', hint: 'Rolling seven days' },
  { id: 'alltime', label: 'All time', hint: 'Every recorded round' },
];

export function LeaderboardPage(): JSX.Element {
  const [window, setWindow] = useState<LeaderboardWindow>('daily');
  const hint = TABS.find((tab) => tab.id === window)?.hint ?? '';

  return (
    <div style={{ width: 'min(1000px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="sub">{hint}. Ranks are computed from the server transaction ledger — only usernames and demo totals are shown.</p>
        </div>
      </div>

      <div className="seg" role="tablist" aria-label="Leaderboard period">
        {TABS.map((tab) => (
          <button key={tab.id} role="tab" aria-selected={tab.id === window} className="seg-btn" data-active={tab.id === window} onClick={() => setWindow(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      <Panel pad={false} title={`${TABS.find((t) => t.id === window)?.label} · demo coins earned`}>
        <LeaderboardTable window={window} />
      </Panel>
    </div>
  );
}
