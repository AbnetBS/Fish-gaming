import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useAuth } from '../state/AuthContext';
import { usePlatform } from '../state/PlatformContext';
import { Avatar, Button, formatCoins } from './ui';
import { audio } from '../game/Audio';
import { BrandMark } from './BrandMark';

const LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/play', label: 'Play' },
  { to: '/tournaments', label: 'Tournaments' },
  { to: '/history', label: 'History' },
  { to: '/wallet', label: 'Wallet' },
  { to: '/leaderboard', label: 'Leaderboard' },
];

export function Shell(): JSX.Element {
  const { user, wallet, logout, isAdmin } = useAuth();
  const { meta } = usePlatform();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="container">
          <BrandMark />
          <nav className="nav hide-mobile" aria-label="Primary">
            {LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {link.label}
              </NavLink>
            ))}
            {isAdmin ? (
              <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
                Admin
              </NavLink>
            ) : null}
          </nav>

          <div className="grow" />

          <button
            type="button"
            className="balance-pill"
            onClick={() => navigate('/wallet')}
            title="Your virtual balance — tap to open the wallet"
          >
            <span aria-hidden="true">◈</span>
            <span className="col" style={{ gap: 0, alignItems: 'flex-start', lineHeight: 1.05 }}>
              <span className="amount">{wallet ? formatCoins(wallet.balance) : '—'}</span>
              <span className="label">{meta?.currency.label ?? 'DEMO COINS'}</span>
            </span>
          </button>

          <div className="row" style={{ gap: '0.45rem' }}>
            <Button size="sm" variant="gold" onClick={() => navigate('/play')}>
              Play
            </Button>
            <button
              type="button"
              className="avatar-btn"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Account menu"
            >
              <Avatar seed={user?.avatarSeed ?? 'guest'} name={user?.username} size={36} />
            </button>
          </div>
        </div>

        {menuOpen ? (
          <div className="account-menu card" role="menu" onMouseLeave={() => setMenuOpen(false)}>
            <div className="head">
              <Avatar seed={user?.avatarSeed ?? 'guest'} name={user?.username} size={40} />
              <div className="col" style={{ gap: 2 }}>
                <strong>{user?.username}</strong>
                <span className="tiny dim">{user?.email}</span>
              </div>
            </div>
            <hr className="divider" style={{ margin: '0.5rem 0' }} />
            {[
              { to: '/profile', label: 'Profile' },
              { to: '/settings', label: 'Settings' },
              { to: '/wallet', label: 'Wallet' },
              { to: '/history', label: 'Game history' },
              { to: '/leaderboard', label: 'Leaderboard' },
              { to: '/responsible-gaming', label: 'Responsible gaming' },
            ].map((item) => (
              <button
                key={item.to}
                type="button"
                role="menuitem"
                onClick={() => {
                  audio.play('click');
                  setMenuOpen(false);
                  navigate(item.to);
                }}
              >
                {item.label}
              </button>
            ))}
            {isAdmin ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  navigate('/admin');
                }}
              >
                Admin panel
              </button>
            ) : null}
            <hr className="divider" style={{ margin: '0.5rem 0' }} />
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={async () => {
                setMenuOpen(false);
                await logout();
                navigate('/');
              }}
            >
              Log out
            </button>
          </div>
        ) : null}
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <footer className="site-footer">
        <div className="container row-between wrap">
          <span className="tiny">
            {meta?.brand.name ?? 'Reef Raiders'} · virtual <strong>DEMO COINS</strong> only — no purchase, no cash value, no withdrawal.
          </span>
          <span className="row tiny">
            <NavLink to="/responsible-gaming">Responsible gaming</NavLink>
            <span className="dim">·</span>
            <span>18+</span>
            <span className="dim">·</span>
            <span className="dim">config {meta?.configVersion ?? '—'}</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
