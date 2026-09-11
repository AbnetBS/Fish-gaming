import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import { useToast } from '../state/toast';
import { Avatar, Badge, Button, Field, Panel, formatCoins, formatDateTime, timeAgo } from '../components/ui';

export function Profile(): JSX.Element {
  const { user, profile, wallet, refreshMe } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ displayName: '', country: '', bio: '', language: 'en' });
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState<{ wagered: number; rewarded: number; rounds: number; net: number } | null>(null);

  useEffect(() => {
    setForm({
      displayName: profile?.displayName ?? user?.username ?? '',
      country: profile?.country ?? '',
      bio: profile?.bio ?? '',
      language: profile?.language ?? 'en',
    });
    api.me().then((me) => setTotals(me.totals)).catch(() => undefined);
  }, [profile, user]);

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.updateProfile({
        displayName: form.displayName.trim() || null,
        country: form.country.trim().toUpperCase() || null,
        bio: form.bio.trim() || null,
        language: form.language,
      });
      await refreshMe();
      toast.push('Profile saved.', 'success');
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save your profile.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: 'min(980px, 100% - 2rem)', marginInline: 'auto' }}>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p className="sub">Public leaderboard entries show your username only.</p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)', alignItems: 'start' }}>
        <Panel title="Account">
          <div className="col" style={{ gap: '0.75rem' }}>
            <div className="row" style={{ gap: '0.75rem' }}>
              <Avatar seed={user?.avatarSeed ?? 'guest'} name={user?.username} size={62} />
              <div className="col" style={{ gap: 2 }}>
                <strong style={{ fontSize: '1.1rem' }}>{user?.username}</strong>
                <span className="tiny dim">{user?.email}</span>
              </div>
            </div>
            <div className="row wrap" style={{ gap: '0.4rem' }}>
              <Badge tone={user?.status === 'ACTIVE' ? 'green' : 'red'}>{user?.status}</Badge>
              <Badge tone="cyan">Role: {user?.role}</Badge>
              <Badge tone={user?.emailVerified ? 'green' : 'gold'}>{user?.emailVerified ? 'Email verified' : 'Email unverified'}</Badge>
            </div>
            <hr className="divider" />
            <dl className="kv">
              <dt>User ID</dt>
              <dd className="num">{user?.id}</dd>
              <dt>Joined</dt>
              <dd>{formatDateTime(user?.createdAt)}</dd>
              <dt>Last active</dt>
              <dd>{timeAgo(user?.lastActiveAt)}</dd>
              <dt>Demo balance</dt>
              <dd className="num">{formatCoins(wallet?.balance ?? 0)}</dd>
              <dt>Rounds played</dt>
              <dd className="num">{totals?.rounds ?? 0}</dd>
            </dl>
          </div>
        </Panel>

        <Panel title="Edit profile">
          <form className="col stack-1" onSubmit={save}>
            <Field label="Display name" hint="Shown on the leaderboard instead of your username if set.">
              <input className="input" value={form.displayName} maxLength={48} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
            </Field>
            <Field label="Country" hint="Two-letter code, optional. This is not used for any eligibility decision.">
              <input className="input" value={form.country} maxLength={2} placeholder="NZ" onChange={(event) => setForm({ ...form, country: event.target.value })} />
            </Field>
            <Field label="About you" hint="280 characters max. No contact details, please.">
              <textarea className="textarea" value={form.bio} maxLength={280} onChange={(event) => setForm({ ...form, bio: event.target.value })} />
            </Field>
            <Field label="Language">
              <select className="select" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="de">Deutsch</option>
                <option value="ja">日本語</option>
              </select>
            </Field>
            <Button variant="primary" type="submit" loading={busy}>Save profile</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}
