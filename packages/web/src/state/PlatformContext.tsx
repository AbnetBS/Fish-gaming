import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type ClientConfig, type MetaPayload } from '../lib/api';

interface PlatformState {
  meta: MetaPayload | null;
  config: ClientConfig | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** The server is the only source of economy values; nothing here is hard-coded. */
  speciesByKey: (key: string) => ClientConfig['fish'][number] | undefined;
  cannonByKey: (key: string) => ClientConfig['cannons'][number] | undefined;
  roomsByBet: (bet: number) => ClientConfig['rooms'][number] | undefined;
}

const PlatformContext = createContext<PlatformState | null>(null);

export function PlatformProvider({ children }: { children: ReactNode }): JSX.Element {
  const [meta, setMeta] = useState<MetaPayload | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [metaPayload, configPayload] = await Promise.all([api.meta(), api.config()]);
      setMeta(metaPayload);
      setConfig(configPayload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Platform configuration unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<PlatformState>(
    () => ({
      meta,
      config,
      error,
      loading,
      reload,
      speciesByKey: (key) => config?.fish.find((f) => f.key === key),
      cannonByKey: (key) => config?.cannons.find((c) => c.key === key),
      roomsByBet: (bet) => config?.rooms.find((r) => bet >= r.minBet && bet <= r.maxBet),
    }),
    [meta, config, error, loading, reload],
  );

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformState {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error('usePlatform must be used inside <PlatformProvider>');
  return ctx;
}
