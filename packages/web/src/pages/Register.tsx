import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import { Button, Field } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { OceanBackdrop } from '../components/OceanBackdrop';
import { useToast } from '../state/toast';
import { ApiError } from '../lib/api';

export function Register(): JSX.Element {
  const { register } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ username: '', email: '', password: '', confirm: '', acceptTerms: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register({ username: form.username, email: form.email, password: form.password, acceptTerms: form.acceptTerms });
      toast.push('Account created. 10,000 DEMO COINS added.', 'success');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create your account right now.');
    } finally {
      setBusy(false);
    }
  };

  const strength = (() => {
    const value = form.password;
    let score = 0;
    if (value.length >= 8) score += 1;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 1;
    if (/\d/.test(value)) score += 1;
    if (/[^A-Za-z0-9]/.test(value) || value.length >= 14) score += 1;
    return score;
  })();

  return (
    <div className="auth-wrap">
      <OceanBackdrop density={0.8} />
      <form className="auth-card card card-pad stack-2" onSubmit={submit}>
        <BrandMark />
        <h1>Create your account</h1>
        <p className="sub">Start with 10,000 DEMO COINS — virtual currency, no purchase, no cash value.</p>

        {error ? (
          <div className="notice-box danger small" role="alert">
            {error}
          </div>
        ) : null}

        <Field label="Username" hint="3–24 characters: letters, numbers or underscore." required>
          <input
            className="input"
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
            autoComplete="username"
            spellCheck={false}
            placeholder="reefhunter"
            required
            minLength={3}
            maxLength={24}
          />
        </Field>
        <Field label="Email" required>
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </Field>
        <Field label="Password" hint="At least 8 characters with a letter and a number." required>
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </Field>
        <div className="pwd-meter" role="img" aria-label={`Password strength ${strength} of 4`}>
          {[0, 1, 2, 3].map((index) => (
            <span key={index} data-on={index < strength} />
          ))}
        </div>
        <Field label="Confirm password" required>
          <input
            className="input"
            type="password"
            value={form.confirm}
            onChange={(event) => setForm({ ...form, confirm: event.target.value })}
            autoComplete="new-password"
            required
          />
        </Field>

        <label className="check">
          <input type="checkbox" checked={form.acceptTerms} onChange={(event) => setForm({ ...form, acceptTerms: event.target.checked })} />
          <span>
            I understand this is an <strong>entertainment demo</strong> using virtual DEMO COINS with no cash value, that nothing can be
            purchased or withdrawn, and I am 18 or over.
          </span>
        </label>

        <Button variant="primary" size="lg" block type="submit" loading={busy} disabled={!form.acceptTerms || !form.username || !form.email || form.password.length < 8}>
          Create account &amp; play
        </Button>
        <div className="tiny center">
          Already registered?{' '}
          <Link to="/login" className="muted">
            Log in
          </Link>
        </div>
      </form>
    </div>
  );
}
