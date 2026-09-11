import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { audio } from '../game/Audio';

/** Small UI primitives shared by the lobby, game shell and admin panel. */

export function Button({
  children,
  variant = 'default',
  size = 'md',
  block,
  loading,
  className = '',
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'gold' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
}): JSX.Element {
  const classes = [
    'btn',
    variant === 'primary' ? 'btn-primary' : variant === 'gold' ? 'btn-gold' : variant === 'ghost' ? 'btn-ghost' : variant === 'danger' ? 'btn-danger' : '',
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    block ? 'btn-block' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      {...rest}
      className={classes}
      disabled={rest.disabled || loading}
      onClick={(event) => {
        void audio.unlock();
        audio.play('click');
        onClick?.(event);
      }}
    >
      {loading ? <span className="spin" aria-hidden="true">◌</span> : null}
      {children}
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="row-between" style={{ padding: '0.9rem 1.1rem', borderBottom: '1px solid var(--line)' }}>
          <h3 className="panel-title">{title}</h3>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      )}
      <div style={pad ? { padding: '1.1rem' } : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'gold' | 'cyan' | 'green' | 'red' }): JSX.Element {
  const color = tone === 'gold' ? 'var(--gold)' : tone === 'cyan' ? 'var(--cyan)' : tone === 'green' ? 'var(--aqua)' : tone === 'red' ? 'var(--danger)' : 'var(--foam)';
  return (
    <div className="stat-tile">
      <div className="k">{label}</div>
      <div className="v" style={{ color }}>
        {value}
      </div>
      {hint ? <div className="tiny dim" style={{ marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

export function Avatar({ seed, size = 34, name }: { seed: string; size?: number; name?: string }): JSX.Element {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const initials = (name ?? seed).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase();
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `conic-gradient(from ${hue}deg, hsl(${hue},70%,55%), hsl(${(hue + 70) % 360},75%,45%), hsl(${(hue + 160) % 360},70%,58%), hsl(${hue},70%,55%))`,
      }}
    >
      {initials}
    </span>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={ref}
        style={wide ? { width: 'min(880px, 100%)' } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="row-between" style={{ padding: '1rem 1.15rem', borderBottom: '1px solid var(--line)' }}>
          <h3 style={{ fontSize: '1.06rem' }}>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div style={{ padding: '1.1rem 1.15rem' }}>{children}</div>
        {footer ? <footer style={{ padding: '0.9rem 1.15rem', borderTop: '1px solid var(--line)' }}>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  required?: boolean;
}): JSX.Element {
  return (
    <label className="field">
      <span>
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="tiny dim">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (value: boolean) => void; label: string }): JSX.Element {
  return (
    <button
      type="button"
      className="switch"
      data-on={on}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => {
        audio.play('click');
        onChange(!on);
      }}
    />
  );
}

export function Skeleton({ height = 14, width = '100%' }: { height?: number; width?: string | number }): JSX.Element {
  return <div className="skeleton" style={{ height, width }} />;
}

export function Empty({ icon = '🐟', title, body, action }: { icon?: string; title: string; body?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="center" style={{ padding: '2.2rem 1rem' }}>
      <div style={{ fontSize: '2rem', opacity: 0.6 }}>{icon}</div>
      <h4 style={{ marginTop: '0.6rem', fontSize: '1.02rem' }}>{title}</h4>
      {body ? <p className="small muted" style={{ marginTop: 4, maxWidth: 420, marginInline: 'auto' }}>{body}</p> : null}
      {action ? <div style={{ marginTop: '0.9rem' }}>{action}</div> : null}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'cyan' | 'gold' | 'green' | 'red' | 'violet' }): JSX.Element {
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{children}</span>;
}

export function DemoCoinLabel(): JSX.Element {
  return (
    <span className="tiny upper" style={{ color: 'var(--gold)', letterSpacing: '0.14em', fontWeight: 800 }}>
      DEMO COINS
    </span>
  );
}

export function formatCoins(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export function formatSigned(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${new Intl.NumberFormat('en-US').format(Math.round(value))}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const delta = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(delta)) return '—';
  const abs = Math.abs(delta);
  const units: [number, string][] = [
    [1000, 's'],
    [60_000, 'm'],
    [3_600_000, 'h'],
    [86_400_000, 'd'],
  ];
  if (abs < 45_000) return delta >= 0 ? 'just now' : 'in a moment';
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const [ms, label] = units[i]!;
    const value = Math.round(abs / ms);
    if (value >= 1 && (i === units.length - 1 || abs >= ms)) return delta >= 0 ? `${value}${label} ago` : `in ${value}${label}`;
  }
  return '—';
}
