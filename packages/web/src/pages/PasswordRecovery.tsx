import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Button, Field } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { OceanBackdrop } from '../components/OceanBackdrop';

export function ForgotPassword(): JSX.Element {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.forgotPassword(email.trim());
      setSent(result.message);
      if (result.devResetToken) setDevToken(result.devResetToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to start a reset right now.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <OceanBackdrop density={0.7} />
      <form className="auth-card card card-pad stack-2" onSubmit={submit}>
        <BrandMark />
        <h1>Reset your password</h1>
        <p className="sub">Enter the email on your account.</p>
        {error ? (
          <div className="notice-box danger small">{error}</div>
        ) : null}
        {sent ? (
          <div className="notice-box info small">
            {sent}
            {devToken ? (
              <div className="col" style={{ marginTop: '0.6rem', gap: '0.4rem' }}>
                <span className="tiny dim">
                  No mail transport is configured in this deployment, so the dev token is shown here. Reset links are emailed in a
                  production build.
                </span>
                <input className="input num" readOnly value={devToken} onFocus={(event) => event.currentTarget.select()} />
                <Link className="btn btn-sm btn-primary" to={`/reset-password?token=${encodeURIComponent(devToken)}`}>
                  Continue to reset
                </Link>
              </div>
            ) : null}
          </div>
        ) : (
          <Field label="Email" required>
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </Field>
        )}
        <Button variant="primary" size="lg" block type="submit" loading={busy} disabled={!email}>
          Send reset instructions
        </Button>
        <div className="tiny center">
          <Link to="/login" className="muted">
            Back to log in
          </Link>
        </div>
      </form>
    </div>
  );
}

export function ResetPassword(): JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!params.get('token')) return;
    setDone(false);
  }, [params]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token.trim(), password);
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to reset the password right now.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <OceanBackdrop density={0.7} />
      <form className="auth-card card card-pad stack-2" onSubmit={submit}>
        <BrandMark />
        <h1>Choose a new password</h1>
        <p className="sub">All other sessions will be signed out.</p>
        {error ? <div className="notice-box danger small">{error}</div> : null}
        {done ? (
          <div className="notice-box info small">Password updated. Taking you back to the log-in screen…</div>
        ) : (
          <>
            <Field label="Reset token" required>
              <input className="input num" value={token} onChange={(event) => setToken(event.target.value)} required placeholder="pasted from the reset email" />
            </Field>
            <Field label="New password" required hint="At least 8 characters.">
              <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password" required>
              <input className="input" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required autoComplete="new-password" />
            </Field>
            <Button variant="primary" size="lg" block type="submit" loading={busy} disabled={!token || password.length < 8}>
              Update password
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
