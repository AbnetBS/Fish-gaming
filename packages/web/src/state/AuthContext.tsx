import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, setTokens, tryRefresh, type AuthPayload, type ProfileDto } from '../lib/api';
import type { PublicUser, Wallet } from '@reef/shared';

interface AuthState {
  user: PublicUser | null;
  profile: ProfileDto | null;
  wallet: Wallet | null;
  permissions: string[];
  loading: boolean;
  bootstrapped: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  register: (input: { username: string; email: string; password: string; acceptTerms: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  setWallet: (wallet: Wallet) => void;
  /** Applies a balance change delivered over the socket without a round-trip. */
  applyBalance: (balance: number) => void;
  isAuthed: boolean;
  isAdmin: boolean;
  error: string | null;
  clearError: () => void;
  /** "New sign-in" alert from the server, honouring the player's own setting. */
  securityNotice: string | null;
  dismissSecurityNotice: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [wallet, setWalletState] = useState<Wallet | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyPayload = useCallback((payload: AuthPayload & { permissions?: string[] }) => {
    if (!mounted.current) return;
    setUser(payload.user);
    setProfile(payload.profile);
    setWalletState(payload.wallet ?? null);
    if (payload.accessToken) setTokens({ accessToken: payload.accessToken, csrfToken: payload.csrfToken ?? null });
    if (payload.permissions) setPermissions(payload.permissions);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const me = await api.me();
      if (!mounted.current) return;
      setUser(me.user);
      setProfile(me.profile);
      setWalletState(me.wallet);
      setError(null);
    } catch (err) {
      const refreshed = await tryRefresh();
      if (!refreshed) {
        if (mounted.current) {
          setUser(null);
          setProfile(null);
          setWalletState(null);
          setPermissions([]);
        }
        return;
      }
      try {
        const me = await api.me();
        if (!mounted.current) return;
        setUser(me.user);
        setProfile(me.profile);
        setWalletState(me.wallet);
      } catch (inner) {
        if (mounted.current) setUser(null);
        void inner;
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
        setBootstrapped(true);
      }
    }
  }, []);

  // Restore the session from the httpOnly refresh cookie on first paint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await tryRefresh();
      if (cancelled) return;
      if (!ok) {
        setLoading(false);
        setBootstrapped(true);
        return;
      }
      await refreshMe();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMe]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.login(identifier, password);
        applyPayload(payload);
        if (mounted.current && payload.securityNotice) setSecurityNotice(payload.securityNotice);
        const me = await api.me();
        if (mounted.current) setPermissions(me.permissions);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unable to sign in right now.');
        throw err;
      } finally {
        if (mounted.current) {
          setLoading(false);
          setBootstrapped(true);
        }
      }
    },
    [applyPayload],
  );

  const register = useCallback(
    async (input: { username: string; email: string; password: string; acceptTerms: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        const payload = await api.register(input);
        applyPayload(payload);
        const me = await api.me();
        if (mounted.current) setPermissions(me.permissions);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Unable to create your account right now.');
        throw err;
      } finally {
        if (mounted.current) {
          setLoading(false);
          setBootstrapped(true);
        }
      }
    },
    [applyPayload],
  );

  const logout = useCallback(async () => {
    try {
      await api.leave().catch(() => undefined);
      await api.logout();
    } finally {
      setTokens(null);
      setUser(null);
      setProfile(null);
      setWalletState(null);
      setPermissions([]);
      setSecurityNotice(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      profile,
      wallet,
      permissions,
      loading,
      bootstrapped,
      login,
      register,
      logout,
      refreshMe,
      setWallet: setWalletState,
      applyBalance: (balance: number) => setWalletState((current) => (current ? { ...current, balance } : current)),
      isAuthed: user !== null,
      isAdmin: user !== null && user.role !== 'USER',
      error,
      clearError: () => setError(null),
      securityNotice,
      dismissSecurityNotice: () => setSecurityNotice(null),
    }),
    [user, profile, wallet, permissions, loading, bootstrapped, login, register, logout, refreshMe, error, securityNotice],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Admin capability check for hiding UI. Real enforcement is always server-side. */
export function usePermission(permission: string): boolean {
  const { permissions } = useAuth();
  return permissions.includes(permission);
}
