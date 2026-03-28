import { useEffect, useState, useCallback, useRef } from 'react';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from './Shell.tsx';

interface Unit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

interface UnitDetail {
  active: string;
  enabled: string;
}

export function Services() {
  const { request, openChannel } = useTransport();
  const su = useSuperuser();
  const [units, setUnits] = useState<Unit[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<UnitDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; unit: string } | null>(null);
  const [password, setPassword] = useState('');
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  const fetchUnits = useCallback(() => {
    request('systemd.units').then((results) => {
      if (Array.isArray(results[0])) {
        setUnits(results[0] as Unit[]);
      }
    });
  }, [request]);

  useEffect(() => {
    setUnits([]);
    setExpanded(null);
    setDetail(null);
    setError(null);

    fetchUnits();

    // Open persistent management channel
    const ch = openChannel('systemd.manage');
    channelRef.current = ch;

    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;
        if (d.type === 'response') {
          const action = d.action as string;
          const data = d.data as Record<string, unknown>;
          setLoading(null);

          if (action === 'status') {
            setDetail(data as unknown as UnitDetail);
          } else if (action === 'list') {
            if (Array.isArray(data?.data)) {
              setUnits(data.data as Unit[]);
            }
          } else if (['start', 'stop', 'restart', 'enable', 'disable', 'reload'].includes(action)) {
            if (data && !data.ok) {
              setError(`${action}: ${data.error || 'failed'}`);
            }
            // Refresh status of expanded unit + list
            const unit = d.unit as string;
            if (unit) {
              ch.send({ action: 'status', unit });
            }
            ch.send({ action: 'list' });
          }
        }
      }
    });

    return () => ch.close();
  }, [fetchUnits, openChannel]);

  const handleExpand = (unitName: string) => {
    if (expanded === unitName) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(unitName);
    setDetail(null);
    setLoading('status');
    channelRef.current?.send({ action: 'status', unit: unitName });
  };

  const requestAction = (action: string, unit: string) => {
    if (su.active) {
      /* superuser mode — execute immediately with stored password */
      setLoading(action);
      setError(null);
      channelRef.current?.send({ action, unit, password: su.password });
      return;
    }
    setPendingAction({ action, unit });
    setPassword('');
    setError(null);
  };

  const confirmAction = () => {
    if (!pendingAction || !password) return;
    setLoading(pendingAction.action);
    setError(null);
    channelRef.current?.send({ action: pendingAction.action, unit: pendingAction.unit, password });
    setPendingAction(null);
    setPassword('');
  };

  const cancelAction = () => {
    setPendingAction(null);
    setPassword('');
  };

  const filtered = units.filter(
    (u) =>
      u.unit?.toLowerCase().includes(filter.toLowerCase()) ||
      u.description?.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div>
      <h2>Services</h2>

      {error && (
        <div style={styles.error}>
          {error}
          <button onClick={() => setError(null)} style={styles.errorClose}>✕</button>
        </div>
      )}

      <input
        type="text"
        placeholder="Filter services..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ ...styles.filter, borderColor: filter ? '#7aa2f7' : '#9ece6a' }}
      />
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Unit</th>
            <th style={styles.th}>Active</th>
            <th style={styles.th}>State</th>
            <th style={styles.th}>Description</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((u) => (
            <ServiceRow
              key={u.unit}
              unit={u}
              isExpanded={expanded === u.unit}
              detail={expanded === u.unit ? detail : null}
              loading={expanded === u.unit ? loading : null}
              pendingAction={expanded === u.unit ? pendingAction : null}
              password={expanded === u.unit ? password : ''}
              onToggle={() => handleExpand(u.unit)}
              onAction={(action) => requestAction(action, u.unit)}
              onPasswordChange={setPassword}
              onConfirm={confirmAction}
              onCancel={cancelAction}
            />
          ))}
        </tbody>
      </table>
      {units.length === 0 && <p style={{ marginTop: '1rem' }}>Loading services...</p>}
    </div>
  );
}

function ServiceRow({ unit, isExpanded, detail, loading, pendingAction, password, onToggle, onAction, onPasswordChange, onConfirm, onCancel }: {
  unit: Unit;
  isExpanded: boolean;
  detail: UnitDetail | null;
  loading: string | null;
  pendingAction: { action: string; unit: string } | null;
  password: string;
  onToggle: () => void;
  onAction: (action: string) => void;
  onPasswordChange: (pw: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isActive = unit.active === 'active';
  const isRunning = unit.sub === 'running';
  const isEnabled = detail?.enabled === 'enabled';
  const isStatic = detail?.enabled === 'static';

  return (
    <>
      <tr onClick={onToggle} style={{ ...styles.clickRow, background: isExpanded ? 'var(--bg-secondary)' : undefined }}>
        <td style={styles.td}>
          <span style={styles.arrow}>{isExpanded ? '▾' : '▸'}</span>
          {unit.unit}
        </td>
        <td style={styles.td}>
          <StatusBadge status={unit.active} />
        </td>
        <td style={styles.td}>{unit.sub}</td>
        <td style={styles.td}>{unit.description}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={4} style={styles.actionCell}>
            <div style={styles.actionBar}>
              {/* Status info */}
              {detail ? (
                <div style={styles.statusInfo}>
                  <span style={styles.statusLabel}>Active:</span>
                  <StatusBadge status={detail.active} />
                  <span style={styles.statusLabel}>Enabled:</span>
                  <EnabledBadge status={detail.enabled} />
                </div>
              ) : loading === 'status' ? (
                <span style={styles.muted}>Loading status…</span>
              ) : null}

              <div style={styles.actionButtons}>
                <ActionBtn
                  label="Start"
                  disabled={isRunning}
                  loading={loading === 'start'}
                  onClick={() => onAction('start')}
                  color="#9ece6a"
                />
                <ActionBtn
                  label="Stop"
                  disabled={!isActive}
                  loading={loading === 'stop'}
                  onClick={() => onAction('stop')}
                  color="#f7768e"
                />
                <ActionBtn
                  label="Restart"
                  disabled={!isActive}
                  loading={loading === 'restart'}
                  onClick={() => onAction('restart')}
                  color="#e0af68"
                />
                <ActionBtn
                  label="Reload"
                  disabled={!isActive}
                  loading={loading === 'reload'}
                  onClick={() => onAction('reload')}
                  color="#7aa2f7"
                />
                <span style={styles.separator} />
                <ActionBtn
                  label="Enable"
                  disabled={isEnabled || isStatic}
                  loading={loading === 'enable'}
                  onClick={() => onAction('enable')}
                  color="#9ece6a"
                />
                <ActionBtn
                  label="Disable"
                  disabled={!isEnabled || isStatic}
                  loading={loading === 'disable'}
                  onClick={() => onAction('disable')}
                  color="#f7768e"
                />
              </div>
            </div>

            {/* Password prompt */}
            {pendingAction && pendingAction.unit === unit.unit && (
              <div style={styles.passwordBar}>
                <span style={styles.passwordLabel}>
                  Password required for <b>{pendingAction.action}</b>:
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => onPasswordChange(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="Enter password…"
                  autoFocus
                  style={{ ...styles.passwordInput, borderColor: password ? '#7aa2f7' : '#9ece6a' }}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); onConfirm(); }}
                  disabled={!password}
                  style={{
                    ...styles.confirmBtn,
                    opacity: password ? 1 : 0.4,
                    cursor: password ? 'pointer' : 'default',
                  }}
                >
                  Confirm
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onCancel(); }}
                  style={styles.cancelBtn}
                >
                  Cancel
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ActionBtn({ label, disabled, loading, onClick, color }: {
  label: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      style={{
        ...styles.actionBtn,
        borderColor: disabled ? 'var(--border)' : color + '66',
        color: disabled ? 'var(--text-secondary)' : color,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      disabled={disabled || loading}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {loading ? '…' : label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'active'
      ? '#9ece6a'
      : status === 'failed'
        ? '#f7768e'
        : status === 'inactive'
          ? '#565f89'
          : '#e0af68';

  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '0.8rem',
      background: color + '22',
      color,
    }}>
      {status}
    </span>
  );
}

function EnabledBadge({ status }: { status: string }) {
  const color =
    status === 'enabled'
      ? '#9ece6a'
      : status === 'disabled'
        ? '#f7768e'
        : status === 'static'
          ? '#7aa2f7'
          : '#565f89';

  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '4px',
      fontSize: '0.8rem',
      background: color + '22',
      color,
    }}>
      {status}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  filter: {
    margin: '1rem 0',
    padding: '0.5rem',
    width: '100%',
    maxWidth: '400px',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '0.9rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  th: {
    textAlign: 'left' as const,
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    textTransform: 'uppercase' as const,
  },
  td: {
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    fontSize: '0.9rem',
  },
  clickRow: {
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  arrow: {
    display: 'inline-block',
    width: '1.2em',
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
  },
  actionCell: {
    padding: 0,
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '0.5rem 0.75rem 0.5rem 2rem',
    flexWrap: 'wrap' as const,
  },
  statusInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    marginRight: '0.5rem',
  },
  statusLabel: {
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  actionButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
  },
  actionBtn: {
    padding: '0.25rem 0.6rem',
    borderRadius: 4,
    border: '1px solid',
    background: 'transparent',
    fontSize: '0.78rem',
    fontWeight: 500,
  },
  separator: {
    display: 'inline-block',
    width: 1,
    height: 18,
    background: 'var(--border)',
    margin: '0 0.25rem',
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
  },
  error: {
    background: '#f7768e22',
    border: '1px solid #f7768e44',
    borderRadius: 6,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    color: '#f7768e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '0.85rem',
  },
  errorClose: {
    background: 'none',
    border: 'none',
    color: '#f7768e',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  passwordBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.75rem 0.6rem 2rem',
    borderTop: '1px dashed var(--border)',
    flexWrap: 'wrap' as const,
  },
  passwordLabel: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap' as const,
  },
  passwordInput: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    width: 200,
  },
  confirmBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid #9ece6a66',
    background: '#9ece6a22',
    color: '#9ece6a',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
};
