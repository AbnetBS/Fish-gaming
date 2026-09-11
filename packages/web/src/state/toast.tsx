import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  message: string;
  ttl: number;
}

interface ToastApi {
  push: (message: string, kind?: Toast['kind'], ttl?: number) => void;
  dismiss: (id: number) => void;
  items: Toast[];
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (message: string, kind: Toast['kind'] = 'info', ttl = 4200) => {
      const id = nextId++;
      setItems((list) => [...list.slice(-3), { id, kind, message, ttl }]);
      const timer = window.setTimeout(() => dismiss(id), ttl);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ push, dismiss, items }), [push, dismiss, items]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((toast) => (
          <div key={toast.id} className="toast" data-kind={toast.kind} onClick={() => dismiss(toast.id)}>
            <span aria-hidden="true">{toast.kind === 'error' ? '⚠' : toast.kind === 'success' ? '✓' : toast.kind === 'warn' ? '!' : 'i'}</span>
            <span className="grow">{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
