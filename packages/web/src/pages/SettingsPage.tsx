import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type PlayLimits, type SelfExclusionDuration } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import { useToast } from '../state/toast';
import { audio } from '../game/Audio';
import { Badge, Button, Field, Panel, Toggle, formatDateTime } from '../components/ui';

/**
 * Account + client settings: audio, autoplay, session limits, password and
 * security. Password changes and session revocation are server operations —
 * this screen only collects them.
 */
export function SettingsPage(): JSX.Element {
  const { user, profile, refreshMe } = useAuth();
  const toast = useToast();
  const [sfx, setSfx] = useState(audio.isEnabled('sfx'));
  const [music, setMusic] = useState(audio.isEnabled('music'));
  const [autoFire, setAutoFire] = useState(() => localStorage.getItem('reef.autofire') === 'true');
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<{ id: string; ip: string | null; userAgent: string | null; createdAt: string }[]>([]);
  const [limits, setLimits] = useState({ sessionLimitMin: profile?.sessionLimitMin ?? 0, loginNotify: profile?.loginNotify ?? true });
  /** Read back from the server: this is exactly what the game enforces. */
  const [usage, setUsage] = useState<PlayLimits | null>(null);
  const [breakBusy, setBreakBusy] = useState(false);

  const loadLimits = useCallback(async (): Promise<void> => {
    try {
      setUsage(await api.playLimits());
    } catch {
      /* the panel still shows the saved preference; enforcement is server-side anyway */
    }
  }, []);

  useEffect(() => {
    api.sessions().then((payload) => setSessions(payload.items)).catch(() => undefined);
    void loadLimits();
  }, [loadLimits]);

  const saveLimits = async (): Promise<void> => {
    try {
      await api.updateProfile({ sessionLimitMin: limits.sessionLimitMin || null, loginNotify: limits.loginNotify });
      await refreshMe();
      await loadLimits();
      toast.push(
        limits.sessionLimitMin > 0
          ? `Daily play limit saved: ${limits.sessionLimitMin} minutes. The server stops your shots after that.`
          : 'Daily play limit removed.',
        'success',
      );
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save limits.', 'error');
    }
  };

  const takeBreak = async (duration: SelfExclusionDuration): Promise<void> => {
    if (!window.confirm(`Start a ${duration} self-exclusion? Play is blocked until it ends and only an admin can lift it early.`)) return;
    setBreakBusy(true);
    try {
      const result = await api.startSelfExclusion(duration);
      await Promise.all([refreshMe(), loadLimits()]);
      toast.push(`Self-exclusion active until ${formatDateTime(result.selfExclusion.until)}.`, 'success');
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not start the break.', 'error');
    } finally {
      setBreakBusy(false);
    }
  };

  const changePassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (passwords.next !== passwords.confirm) {
      toast.push('New passwords do not match.', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api.changePassword(passwords.current, passwords.next);
      toast.push(result.message, 'success');
      setPasswords({ current: '', next: '', confirm: '' });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not change your password.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: 'min(980px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Client preferences plus account security.</p>
        </div>
        <Badge tone="gold">Demo product</Badge>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'start' }}>
        <Panel title="Audio & gameplay">
          <div className="col" style={{ gap: '0.85rem' }}>
            <div className="row-between">
              <div>
                <strong>Sound effects</strong>
                <div className="tiny dim">Shots, hits and reward chimes</div>
              </div>
              <Toggle on={sfx} label="Sound effects" onChange={(value) => { setSfx(value); audio.setEnabled('sfx', value); }} />
            </div>
            <div className="row-between">
              <div>
                <strong>Music</strong>
                <div className="tiny dim">Synthesised ambient bed</div>
              </div>
              <Toggle on={music} label="Music" onChange={(value) => { setMusic(value); audio.setEnabled('music', value); }} />
            </div>
            <div className="row-between">
              <div>
                <strong>Auto-fire by default</strong>
                <div className="tiny dim">Start every room with auto-fire enabled</div>
              </div>
              <Toggle
                on={autoFire}
                label="Auto-fire by default"
                onChange={(value) => {
                  setAutoFire(value);
                  localStorage.setItem('reef.autofire', String(value));
                }}
              />
            </div>
            <hr className="divider" />
            <div className="row-between">
              <div>
                <strong>Daily play limit</strong>
                <div className="tiny dim">
                  {usage && usage.limitMin > 0
                    ? `${usage.minutesPlayedToday} of ${usage.limitMin} minutes used today · shots stop at the limit`
                    : 'Stops your shots after this many minutes today (0 = off)'}
                </div>
              </div>
              <input
                className="number-input"
                style={{ width: 88 }}
                type="number"
                min={0}
                max={1440}
                step={15}
                value={limits.sessionLimitMin}
                onChange={(event) => setLimits({ ...limits, sessionLimitMin: Math.max(0, Math.min(1440, Number(event.target.value) || 0)) })}
              />
            </div>
            <div className="row-between">
              <div>
                <strong>New sign-in alerts</strong>
                <div className="tiny dim">Warn me when a sign-in comes from a browser with no other active session</div>
              </div>
              <Toggle on={limits.loginNotify} label="New sign-in alerts" onChange={(value) => setLimits({ ...limits, loginNotify: value })} />
            </div>
            <Button variant="primary" onClick={() => void saveLimits()}>Save limits</Button>
          </div>
        </Panel>

        <Panel title="Taking a break">
          <div className="col" style={{ gap: '0.85rem' }}>
            {usage?.selfExcludedUntil ? (
              <div className="notice-box" role="status">
                <strong className="small">Self-exclusion is active</strong>
                <div className="tiny dim">Play is blocked until {formatDateTime(usage.selfExcludedUntil)}. A support or compliance admin can lift it; you cannot.</div>
              </div>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                A self-exclusion closes your current round immediately, refuses new joins and cannot be shortened by you. It is the strongest
                control in this demo — there are no real funds to lose here, so treat it as a habit break.
              </p>
            )}
            <div className="row wrap" style={{ gap: '0.5rem' }}>
              {(['24h', '7d', '30d', '90d'] as const).map((duration) => (
                <Button key={duration} size="sm" variant="ghost" disabled={breakBusy} onClick={() => void takeBreak(duration)}>
                  {duration === '24h' ? '24 hours' : duration === '7d' ? '7 days' : duration === '30d' ? '30 days' : '90 days'}
                </Button>
              ))}
            </div>
            <div className="tiny dim">
              Today you have played {usage ? usage.minutesPlayedToday : '—'} minute(s) across all rooms. Minutes are counted from your real play
              sessions, not from the clock on this page.
            </div>
          </div>
        </Panel>

        <Panel title="Password">
          <form className="col stack-1" onSubmit={changePassword}>
            <Field label="Current password" required>
              <input className="input" type="password" autoComplete="current-password" value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} required />
            </Field>
            <Field label="New password" required hint="At least 8 characters, including a letter and a number.">
              <input className="input" type="password" autoComplete="new-password" value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} required minLength={8} />
            </Field>
            <Field label="Confirm new password" required>
              <input className="input" type="password" autoComplete="new-password" value={passwords.confirm} onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })} required />
            </Field>
            <Button variant="primary" type="submit" loading={busy} disabled={!passwords.current || passwords.next.length < 8}>
              Change password
            </Button>
            <p className="tiny dim">Changing your password signs you out of every other device.</p>
          </form>
        </Panel>

        <Panel title="Active sessions" actions={<Button size="sm" variant="danger" onClick={async () => { await api.revokeAllSessions(); toast.push('Signed out everywhere else.', 'success'); }}>Sign out others</Button>}>
          {sessions.length === 0 ? (
            <p className="small muted">No other recorded sessions.</p>
          ) : (
            <ul className="session-list" style={{ margin: '-0.4rem -0.4rem 0' }}>
              {sessions.map((session) => (
                <li key={session.id} style={{ padding: '0.5rem 0.1rem' }}>
                  <span className="col" style={{ gap: 1 }}>
                    <strong className="small">{session.ip ?? 'unknown IP'}</strong>
                    <span className="tiny dim" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {session.userAgent ?? 'unknown device'}
                    </span>
                  </span>
                  <span className="tiny dim nowrap">{formatDateTime(session.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <hr className="divider" />
          <div className="row-between">
            <div>
              <strong>Close the account</strong>
              <div className="tiny dim">Suspend access and stop all play. Your ledger history is retained for audit.</div>
            </div>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                if (!window.confirm('Request account closure? Support will need to reopen it.')) return;
                await api.logout();
                toast.push('Signed out. Account closure must be confirmed by support.', 'info');
              }}
            >
              Log out & request
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
