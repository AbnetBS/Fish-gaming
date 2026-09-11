import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import { Button, Field } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { OceanBackdrop } from '../components/OceanBackdrop';
import { useToast } from '../state/toast';
import { ApiError } from '../lib/api';

export function Login(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), password);
      toast.push('Welcome back.', 'success');
      navigate(params.get('next') ?? '/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in right now.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <OceanBackdrop density={0.8} />
      <form className="auth-card card card-pad stack-2" onSubmit={submit}>
        <BrandMark />
        <h1>Log in</h1>
        <p className="sub">Your demo coins and history are waiting.</p>

        {error ? (
          <div className="notice-box danger small" role="alert">
            {error}
          </div>
        ) : null}

        <Field label="Email or username" required>
          <input
            className="input"
            value={identifier}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field label="Password" required>
          <input
            className="input"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            required
          />
        </Field>

        <Button variant="primary" size="lg" block loading={busy} type="submit" disabled={!identifier || !password}>
          Log in
        </Button>

        <div className="row-between tiny">
          <Link to="/forgot-password" className="muted">
            Forgot password?
          </Link>
          <Link to="/register" className="muted">
            Create an account
          </Link>
        </div>
        <div className="tiny dim center">Demo product · virtual coins only · 18+</div>
      </form>
    </div>
  );
}

