import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './state/AuthContext';
import { Shell } from './components/Shell';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword, ResetPassword } from './pages/PasswordRecovery';
import { Dashboard } from './pages/Dashboard';
import { Rooms } from './pages/Rooms';
import { Tournaments } from './pages/Tournaments';
import { Play } from './pages/Play';
import { History } from './pages/History';
import { WalletPage } from './pages/WalletPage';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { Profile } from './pages/Profile';
import { SettingsPage } from './pages/SettingsPage';
import { ResponsibleGaming } from './pages/ResponsibleGaming';
import { NotFound } from './pages/NotFound';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { AdminUsers } from './pages/admin/AdminUsers';
import { AdminRooms } from './pages/admin/AdminRooms';
import { AdminTournaments } from './pages/admin/AdminTournaments';
import { AdminFish } from './pages/admin/AdminFish';
import { AdminCannons } from './pages/admin/AdminCannons';
import { AdminSettings } from './pages/admin/AdminSettings';
import { AdminHistory } from './pages/admin/AdminHistory';
import { AdminTransactions } from './pages/admin/AdminTransactions';
import { AdminReports } from './pages/admin/AdminReports';
import { AdminAudit } from './pages/admin/AdminAudit';
import { AdminSystem } from './pages/admin/AdminSystem';

/**
 * Routing.
 *
 * `Protected` only decides what is *rendered*. Authentication and capability
 * checks are re-performed by the API on every call, so hiding a page is a
 * convenience and never a security control — an unauthorised token still gets
 * HTTP 401/403 from the server even if the client were modified.
 */
export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/responsible-gaming" element={<ResponsibleGaming />} />

      <Route element={<Protected />}>
        <Route element={<Shell />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/play" element={<Rooms />} />
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/history" element={<History />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      {/* The game screen owns the whole viewport, so it sits outside the shell. */}
      <Route element={<Protected />}>
        <Route path="/play/:roomKey" element={<Play />} />
        <Route path="/play/tournament/:tournamentId" element={<Play />} />
      </Route>

      <Route element={<Protected admin />}>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="rooms" element={<AdminRooms />} />
          <Route path="tournaments" element={<AdminTournaments />} />
          <Route path="fish" element={<AdminFish />} />
          <Route path="cannons" element={<AdminCannons />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="history" element={<AdminHistory />} />
          <Route path="transactions" element={<AdminTransactions />} />
          <Route path="reports" element={<AdminReports />} />
          <Route path="audit" element={<AdminAudit />} />
          <Route path="system" element={<AdminSystem />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function Protected({ admin = false }: { admin?: boolean }): JSX.Element {
  const { isAuthed, isAdmin, loading, bootstrapped, user } = useAuth();
  const location = useLocation();
  const next = encodeURIComponent(`${location.pathname}${location.search}`);

  if (!bootstrapped || (loading && !isAuthed)) {
    return (
      <div className="boot-screen">
        <div className="boot-inner">
          <div className="boot-ring" aria-hidden="true" />
          <p className="muted small">Loading the reef…</p>
        </div>
      </div>
    );
  }
  if (!isAuthed) return <Navigate to={`/login?next=${next}`} replace />;
  if (admin && (!isAdmin || user?.role === 'USER')) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
