import React, { createContext, useCallback, useContext, useState } from 'react';

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

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const add = useCallback((type: ToastType, message: string) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev.slice(-4), { id, type, message }]);
    setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);

  const api: ToastAPI = {
    success: (msg) => add('success', msg),
    error:   (msg) => add('error',   msg),
    info:    (msg) => add('info',    msg),
    warn:    (msg) => add('warn',    msg),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

// ── Toast container ────────────────────────────────────────────────────────────

const COLORS: Record<ToastType, string> = {
  success: '#9ece6a',
  error:   '#f7768e',
  info:    '#7aa2f7',
  warn:    '#e0af68',
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
      background: '#1e2030', border: `1px solid ${color}44`,
      borderLeft: `3px solid ${color}`, borderRadius: 6,
      padding: '0.55rem 0.75rem',
      boxShadow: `0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px ${color}11`,
      minWidth: 240, maxWidth: 360,
      pointerEvents: 'all', cursor: 'default',
      animation: 'toast-in 0.18s ease',
    }}>
      <span style={{ color, fontWeight: 700, fontSize: '0.85rem', flexShrink: 0, marginTop: 1 }}>
        {ICONS[toast.type]}
      </span>
      <span style={{ flex: 1, fontSize: '0.84rem', color: 'var(--text-primary)', lineHeight: 1.4 }}>
        {toast.message}
      </span>
      <button
        onClick={() => onDismiss(toast.id)}
        style={{
          background: 'none', border: 'none', color: 'var(--text-secondary)',
          cursor: 'pointer', fontSize: '0.85rem', padding: 0, flexShrink: 0, marginTop: 1,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}
