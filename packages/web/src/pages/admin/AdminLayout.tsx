import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../state/AuthContext';
import { usePlatform } from '../../state/PlatformContext';
import { Badge, Button } from '../../components/ui';
import { BrandMark } from '../../components/BrandMark';

const NAV: { group: string; items: { to: string; label: string; permission?: string }[] }[] = [
  {
    group: 'Overview',
    items: [{ to: '/admin', label: 'Dashboard' }],
  },
  {
    group: 'Game design',
    items: [
      { to: '/admin/fish', label: 'Fish', permission: 'fish:read' },
      { to: '/admin/cannons', label: 'Cannons', permission: 'cannons:read' },
      { to: '/admin/rooms', label: 'Game rooms', permission: 'rooms:read' },
      { to: '/admin/settings', label: 'Game settings', permission: 'config:read' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { to: '/admin/users', label: 'Users', permission: 'users:read' },
      { to: '/admin/history', label: 'Game history', permission: 'history:read' },
      { to: '/admin/transactions', label: 'Transactions', permission: 'transactions:read' },
      { to: '/admin/reports', label: 'Reports', permission: 'reports:read' },
    ],
  },
  {
    group: 'Control',
    items: [
      { to: '/admin/audit', label: 'Audit log', permission: 'audit:read' },
      { to: '/admin/system', label: 'System settings', permission: 'settings:read' },
    ],
  },
];

export function AdminLayout(): JSX.Element {
  const { user, permissions, logout } = useAuth();
  const { meta } = usePlatform();
  const location = useLocation();
  const [maintenance, setMaintenance] = useState(false);

  useEffect(() => {
    api
      .health()
      .then((payload) => setMaintenance(payload.maintenance))
      .catch(() => undefined);
  }, [location.pathname]);

  const allowed = (permission?: string): boolean => !permission || permissions.includes(permission);

  return (
    <div className="admin-shell">
      <aside className="admin-side">
        <div className="brand" style={{ padding: '0.2rem 0.55rem 0.9rem' }}>
          <BrandMark />
        </div>
        {NAV.map((group) => {
          const items = group.items.filter((item) => allowed(item.permission));
          if (!items.length) return null;
          return (
            <div key={group.group}>
              <div className="group-label">{group.group}</div>
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/admin'} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          );
        })}
        <div className="grow" />
        <div className="group-label">Session</div>
        <NavLink to="/dashboard">Back to player view</NavLink>
        <button
          className="admin-exit"
          onClick={async () => {
            await logout();
          }}
        >
          Log out
        </button>
      </aside>

      <main className="admin-main">
        <div className="admin-top">
          <div className="grow col" style={{ gap: 2 }}>
            <h1>Operator console</h1>
            <span className="tiny dim">
              {user?.username} · {user?.role} · config {meta?.configVersion ?? '—'}
            </span>
          </div>
          {maintenance ? <Badge tone="red">Maintenance mode on</Badge> : null}
          <Badge tone="gold">Demo statistics only</Badge>
          <Badge tone={meta?.flags.realMoneyEnabled ? 'red' : 'green'}>Real money: {meta?.flags.realMoneyEnabled ? 'enabled' : 'disabled'}</Badge>
          <Button size="sm" variant="ghost" onClick={() => window.print()}>
            Print
          </Button>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
