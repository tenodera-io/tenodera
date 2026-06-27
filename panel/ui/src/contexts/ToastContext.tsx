import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warn';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastAPI {
  success: (msg: string) => void;
  error:   (msg: string) => void;
  info:    (msg: string) => void;
  warn:    (msg: string) => void;
}

const ToastContext = createContext<ToastAPI>({
  success: () => {},
  error:   () => {},
  info:    () => {},
  warn:    () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

const MAX_VISIBLE = 5;
const MAX_TOTAL   = 10;
const DISMISS_MS  = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timerMap = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timerMap.current.get(id));
    timerMap.current.delete(id);
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const add = useCallback((type: ToastType, message: string) => {
    setToasts(prev => {
      if (prev.length >= MAX_TOTAL) return prev; // queue full — drop
      const id = Date.now() + Math.random();
      return [...prev, { id, type, message }];
    });
  }, []);

  // Start dismiss timer when a toast enters the visible zone (first MAX_VISIBLE slots).
  // Fires whenever toasts array changes — catches both new arrivals and promotions
  // from queue after a visible slot opens.
  useEffect(() => {
    const visible = toasts.slice(0, MAX_VISIBLE);
    for (const t of visible) {
      if (!timerMap.current.has(t.id)) {
        const timer = setTimeout(() => dismiss(t.id), DISMISS_MS);
        timerMap.current.set(t.id, timer);
      }
    }
    // Clean up timers for toasts no longer in the list (manually dismissed)
    for (const [id, timer] of timerMap.current) {
      if (!toasts.find(t => t.id === id)) {
        clearTimeout(timer);
        timerMap.current.delete(id);
      }
    }
  }, [toasts, dismiss]);

  const api: ToastAPI = {
    success: (msg) => add('success', msg),
    error:   (msg) => add('error',   msg),
    info:    (msg) => add('info',    msg),
    warn:    (msg) => add('warn',    msg),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer toasts={toasts.slice(0, MAX_VISIBLE)} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ── Toast container ────────────────────────────────────────────────────────────

const COLORS: Record<ToastType, string> = {
  success: 'var(--c-green)',
  error:   'var(--c-red)',
  info:    'var(--c-blue)',
  warn:    'var(--c-yellow)',
};

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  info:    'ℹ',
  warn:    '⚠',
};

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div style={{
      position: 'fixed', top: '1rem', right: '1rem',
      display: 'flex', flexDirection: 'column', gap: '0.5rem',
      zIndex: 9999, pointerEvents: 'none',
    }}>
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const color = COLORS[toast.type];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
      background: 'var(--bg-app)', border: `1px solid color-mix(in srgb, ${color} 27%, transparent)`,
      borderLeft: `3px solid ${color}`, borderRadius: 6,
      padding: '0.55rem 0.75rem',
      boxShadow: `0 4px 16px rgba(0,0,0,0.4)`,
      minWidth: 240, maxWidth: 360,
      pointerEvents: 'all', cursor: 'default',
      animation: 'toast-in 0.18s ease',
    }}>
      <span style={{ color, fontWeight: 700, fontSize: '0.85rem', flexShrink: 0, marginTop: 1 }}>
        {ICONS[toast.type]}
      </span>
      <span style={{ flex: 1, fontSize: '0.84rem', color: 'var(--text-1)', lineHeight: 1.4 }}>
        {toast.message}
      </span>
      <button
        onClick={() => onDismiss(toast.id)}
        style={{
          background: 'none', border: 'none', color: 'var(--text-2)',
          cursor: 'pointer', fontSize: '0.85rem', padding: 0, flexShrink: 0, marginTop: 1,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}
