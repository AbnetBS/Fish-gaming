import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Skeleton } from '../../components/ui';

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (next: T) => void;
}

/** Small data-fetching helper so every admin screen behaves identically. */
export function useResource<T>(loader: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((next) => {
        setData(next);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Request failed.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload, setData };
}

export function AdminState({ error, loading, empty, children }: { error?: string | null; loading?: boolean; empty?: boolean; children: ReactNode }): JSX.Element {
  if (error) {
    return (
      <div className="notice-box danger small" role="alert">
        {error}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="col">
        <Skeleton height={38} />
        <Skeleton height={38} />
        <Skeleton height={38} />
        <Skeleton height={38} />
      </div>
    );
  }
  if (empty) return <Badge>Nothing to show yet</Badge>;
  return <>{children}</>;
}

export function SaveButton({ saving, dirty, children }: { saving: boolean; dirty: boolean; children?: ReactNode }): JSX.Element {
  return (
    <Button size="sm" variant="primary" loading={saving} disabled={!dirty}>
      {children ?? (dirty ? 'Save' : 'Saved')}
    </Button>
  );
}

export function NumberCell({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
}): JSX.Element {
  return (
    <label className="col" style={{ gap: 2 }}>
      <span className="tiny dim upper">{label}</span>
      <input
        className="number-input"
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? next : 0);
        }}
      />
    </label>
  );
}

export function DemoNote(): JSX.Element {
  return (
    <p className="tiny dim" style={{ marginTop: '0.6rem' }}>
      All values are virtual DEMO COINS. Changes apply to rounds started after you publish a new configuration version — a round in
      progress keeps the version it began with.
    </p>
  );
}
