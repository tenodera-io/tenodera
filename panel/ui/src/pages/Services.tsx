import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

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

interface TimerEntry {
  unit: string;
  active: string;
  sub: string;
  description: string;
  next: string;
  last: string;
  enabled: string;
  triggers: string;
}

type Tab = 'services' | 'timers';

// ── Column sorting ─────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc' | null;
type SortCol = 'active' | 'state' | null;

const ACTIVE_ORDER: Record<string, number> = { active: 0, activating: 1, deactivating: 2, inactive: 3, failed: 4 };
const STATE_ORDER: Record<string, number> = { running: 0, exited: 1, dead: 2, waiting: 3, mounted: 4 };

function nextDir(current: SortDir): SortDir {
  if (current === null) return 'desc';
  if (current === 'desc') return 'asc';
  return null;
}

function sortArrow(dir: SortDir): string {
  if (dir === 'desc') return ' ▼';
  if (dir === 'asc') return ' ▲';
  return '';
}

function applySorting(list: Unit[], col: SortCol, dir: SortDir): Unit[] {
  if (!col || !dir) return list;
  const sorted = [...list];
  const mul = dir === 'desc' ? 1 : -1;
  if (col === 'active') {
    sorted.sort((a, b) => mul * ((ACTIVE_ORDER[a.active] ?? 99) - (ACTIVE_ORDER[b.active] ?? 99)));
  } else {
    sorted.sort((a, b) => mul * ((STATE_ORDER[a.sub] ?? 99) - (STATE_ORDER[b.sub] ?? 99)));
  }
  return sorted;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function Services() {
  const { request, openChannel } = useTransport();
  const su = useSuperuser();
  const [activeTab, setActiveTab] = useTabParam<Tab>(['services', 'timers'], 'services');
  const [units, setUnits] = useState<Unit[]>([]);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<UnitDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; unit: string } | null>(null);
  const [password, setPassword] = useState('');
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

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

  const filtered = applySorting(
    units.filter(
      (u) =>
        u.unit?.toLowerCase().includes(filter.toLowerCase()) ||
        u.description?.toLowerCase().includes(filter.toLowerCase()),
    ),
    sortCol,
    sortDir,
  );

  const handleSort = (col: 'active' | 'state') => {
    if (sortCol === col) {
      const nd = nextDir(sortDir);
      setSortDir(nd);
      if (nd === null) setSortCol(null);
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  };

  return (
    <div>
      <PageHeader icon="services" title="Services" />

      {/* Tab bar */}
      <Tabs
        tabs={[{ id: 'services', label: 'Services' }, { id: 'timers', label: 'Timers' }]}
        active={activeTab}
        onChange={(t) => setActiveTab(t as Tab)}
        style={{ marginBottom: '1rem' }}
      />

      {activeTab === 'timers' ? (
        <TimersTab su={su} />
      ) : (
        <>
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
            style={{ ...styles.filter, borderColor: filter ? 'var(--c-blue)' : 'var(--c-green)' }}
          />
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Unit</th>
                <th style={styles.thSort} onClick={() => handleSort('active')}>
                  Active{sortCol === 'active' ? sortArrow(sortDir) : ''}
                </th>
                <th style={styles.thSort} onClick={() => handleSort('state')}>
                  State{sortCol === 'state' ? sortArrow(sortDir) : ''}
                </th>
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
        </>
      )}
    </div>
  );
}

// ── Timers tab ─────────────────────────────────────────────────────────────────

function TimersTab({ su }: { su: ReturnType<typeof useSuperuser> }) {
  const { request, openChannel } = useTransport();
  const [timers, setTimers] = useState<TimerEntry[]>([]);
  const [fetching, setFetching] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; unit: string } | null>(null);
  const [password, setPassword] = useState('');
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  const fetchTimers = useCallback(() => {
    setFetching(true);
    request('systemd.timers', {}).then((results) => {
      if (Array.isArray(results[0])) {
        setTimers(results[0] as TimerEntry[]);
      }
      setFetching(false);
    }).catch(() => setFetching(false));
  }, [request]);

  useEffect(() => {
    fetchTimers();

    const ch = openChannel('systemd.manage');
    channelRef.current = ch;

    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;
        if (d.type === 'response') {
          const action = d.action as string;
          const data = d.data as Record<string, unknown>;
          setActionLoading(null);

          if (['start', 'stop', 'enable', 'disable'].includes(action)) {
            if (data && !data.ok) {
              setError(`${action}: ${data.error || 'failed'}`);
            }
            fetchTimers();
          }
        }
      }
    });

    return () => ch.close();
  }, [fetchTimers, openChannel]);

  const requestAction = (action: string, unit: string) => {
    if (su.active) {
      setActionLoading(`${action}:${unit}`);
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
    setActionLoading(`${pendingAction.action}:${pendingAction.unit}`);
    setError(null);
    channelRef.current?.send({ action: pendingAction.action, unit: pendingAction.unit, password });
    setPendingAction(null);
    setPassword('');
  };

  return (
    <>
      <div style={styles.timerToolbar}>
        <button style={styles.refreshBtn} onClick={fetchTimers} disabled={fetching}>
          {fetching ? '…' : '↻ Refresh'}
        </button>
        {fetching && <span style={styles.muted}>Loading…</span>}
      </div>

      {error && (
        <div style={styles.error}>
          {error}
          <button onClick={() => setError(null)} style={styles.errorClose}>✕</button>
        </div>
      )}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Unit</th>
            <th style={styles.th}>Triggers</th>
            <th style={styles.th}>Active</th>
            <th style={styles.th}>Enabled</th>
            <th style={styles.th}>Next</th>
            <th style={styles.th}>Last</th>
            <th style={styles.th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {timers.map((t) => {
            const key = t.unit;
            const isActive = t.active === 'active';
            const isEnabled = t.enabled === 'enabled';
            const isStatic = t.enabled === 'static';
            const isPending = pendingAction?.unit === key;

            return (
              <Fragment key={key}>
                <tr style={isPending ? { background: 'var(--bg-panel)' } : undefined}>
                  <td style={styles.td}>
                    <span style={styles.timerUnit}>{t.unit}</span>
                    {t.description && <div style={styles.timerDesc}>{t.description}</div>}
                  </td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {t.triggers || '—'}
                  </td>
                  <td style={styles.td}>
                    <StatusBadge status={t.active} />
                    {t.sub && t.sub !== t.active && (
                      <span style={styles.subState}>{t.sub}</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <EnabledBadge status={t.enabled} />
                  </td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.8rem', color: t.next === 'n/a' ? 'var(--text-2)' : 'var(--text-1)' }}>
                    {t.next}
                  </td>
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.8rem', color: t.last === 'n/a' ? 'var(--text-2)' : 'var(--text-1)' }}>
                    {t.last}
                  </td>
                  <td style={styles.td}>
                    <div style={styles.actionButtons}>
                      <ActionBtn
                        label="Start"
                        disabled={isActive}
                        loading={actionLoading === `start:${key}`}
                        onClick={() => requestAction('start', key)}
                        color="var(--c-green)"
                      />
                      <ActionBtn
                        label="Stop"
                        disabled={!isActive}
                        loading={actionLoading === `stop:${key}`}
                        onClick={() => requestAction('stop', key)}
                        color="var(--c-red)"
                      />
                      <span style={styles.separator} />
                      <ActionBtn
                        label="Enable"
                        disabled={isEnabled || isStatic}
                        loading={actionLoading === `enable:${key}`}
                        onClick={() => requestAction('enable', key)}
                        color="var(--c-green)"
                      />
                      <ActionBtn
                        label="Disable"
                        disabled={!isEnabled || isStatic}
                        loading={actionLoading === `disable:${key}`}
                        onClick={() => requestAction('disable', key)}
                        color="var(--c-red)"
                      />
                    </div>
                  </td>
                </tr>
                {isPending && (
                  <tr>
                    <td colSpan={7} style={{ ...styles.actionCell }}>
                      <div style={styles.passwordBar}>
                        <span style={styles.passwordLabel}>
                          Password required for <b>{pendingAction!.action}</b>:
                        </span>
                        <input
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') confirmAction();
                            if (e.key === 'Escape') { setPendingAction(null); setPassword(''); }
                          }}
                          placeholder="Enter password…"
                          autoFocus
                          style={{ ...styles.passwordInput, borderColor: password ? 'var(--c-blue)' : 'var(--c-green)' }}
                        />
                        <button
                          onClick={confirmAction}
                          disabled={!password}
                          style={{ ...styles.confirmBtn, opacity: password ? 1 : 0.4, cursor: password ? 'pointer' : 'default' }}
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => { setPendingAction(null); setPassword(''); }}
                          style={styles.cancelBtn}
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {!fetching && timers.length === 0 && (
        <p style={{ marginTop: '1rem', color: 'var(--text-2)' }}>No timers found.</p>
      )}
    </>
  );
}

// ── Service row ────────────────────────────────────────────────────────────────

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
      <tr onClick={onToggle} style={{ ...styles.clickRow, background: isExpanded ? 'var(--bg-panel)' : undefined }}>
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
                <ActionBtn label="Start"   disabled={isRunning}  loading={loading === 'start'}   onClick={() => onAction('start')}   color="var(--c-green)" />
                <ActionBtn label="Stop"    disabled={!isActive}  loading={loading === 'stop'}    onClick={() => onAction('stop')}    color="var(--c-red)" />
                <ActionBtn label="Restart" disabled={!isActive}  loading={loading === 'restart'} onClick={() => onAction('restart')} color="var(--c-yellow)" />
                <ActionBtn label="Reload"  disabled={!isActive}  loading={loading === 'reload'}  onClick={() => onAction('reload')}  color="var(--c-blue)" />
                <span style={styles.separator} />
                <ActionBtn label="Enable"  disabled={isEnabled || isStatic}  loading={loading === 'enable'}  onClick={() => onAction('enable')}  color="var(--c-green)" />
                <ActionBtn label="Disable" disabled={!isEnabled || isStatic} loading={loading === 'disable'} onClick={() => onAction('disable')} color="var(--c-red)" />
              </div>
            </div>

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
                  style={{ ...styles.passwordInput, borderColor: password ? 'var(--c-blue)' : 'var(--c-green)' }}
                />
                <button
                  onClick={(e) => { e.stopPropagation(); onConfirm(); }}
                  disabled={!password}
                  style={{ ...styles.confirmBtn, opacity: password ? 1 : 0.4, cursor: password ? 'pointer' : 'default' }}
                >
                  Confirm
                </button>
                <button onClick={(e) => { e.stopPropagation(); onCancel(); }} style={styles.cancelBtn}>
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

// ── Shared sub-components ──────────────────────────────────────────────────────

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
        borderColor: disabled ? 'var(--border-1)' : `color-mix(in srgb, ${color} 40%, transparent)`,
        color: disabled ? 'var(--text-2)' : color,
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
    status === 'active'   ? 'var(--c-green)' :
    status === 'failed'   ? 'var(--c-red)' :
    status === 'inactive' ? 'var(--text-3)' : 'var(--c-yellow)';

  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', background: color, color: 'var(--badge-fg)' }}>
      {status}
    </span>
  );
}

function EnabledBadge({ status }: { status: string }) {
  const color =
    status === 'enabled'  ? 'var(--c-green)' :
    status === 'disabled' ? 'var(--c-red)' :
    status === 'static'   ? 'var(--c-blue)' : 'var(--text-3)';

  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', background: color, color: 'var(--badge-fg)' }}>
      {status}
    </span>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex',
    gap: '0.25rem',
    borderBottom: '1px solid var(--border)',
    marginBottom: '1rem',
  },
  tab: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-2)',
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    fontSize: '0.9rem',
    borderBottom: '2px solid transparent',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    transition: 'color 0.15s',
  },
  tabActive: {
    color: 'var(--c-blue)',
    borderBottom: '2px solid var(--c-blue)',
  },
  timerToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '0.75rem',
  },
  refreshBtn: {
    padding: '0.3rem 0.8rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--c-blue)',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  timerUnit: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
  },
  timerDesc: {
    fontSize: '0.75rem',
    color: 'var(--text-2)',
    marginTop: '0.15rem',
  },
  subState: {
    marginLeft: '0.4rem',
    fontSize: '0.75rem',
    color: 'var(--text-2)',
  },
  filter: {
    margin: '1rem 0',
    padding: '0.5rem',
    width: '100%',
    maxWidth: '400px',
    borderRadius: '4px',
    border: '1px solid var(--c-green)',
    background: 'var(--bg-panel)',
    color: 'var(--text-1)',
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
    color: 'var(--text-2)',
    fontSize: '0.8rem',
    textTransform: 'uppercase' as const,
  },
  thSort: {
    textAlign: 'left' as const,
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-2)',
    fontSize: '0.8rem',
    textTransform: 'uppercase' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  },
  td: {
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    fontSize: '0.9rem',
    verticalAlign: 'top' as const,
  },
  clickRow: {
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  arrow: {
    display: 'inline-block',
    width: '1.2em',
    fontSize: '0.75rem',
    color: 'var(--text-2)',
  },
  actionCell: {
    padding: 0,
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-panel)',
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
    color: 'var(--text-2)',
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
    color: 'var(--text-2)',
    fontSize: '0.8rem',
  },
  error: {
    background: 'color-mix(in srgb, var(--c-red) 13%, transparent)',
    border: '1px solid color-mix(in srgb, var(--c-red) 27%, transparent)',
    borderRadius: 6,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    color: 'var(--c-red)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '0.85rem',
  },
  errorClose: {
    background: 'none',
    border: 'none',
    color: 'var(--c-red)',
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
    color: 'var(--text-2)',
    whiteSpace: 'nowrap' as const,
  },
  passwordInput: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid var(--c-green)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    width: 200,
  },
  confirmBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid color-mix(in srgb, var(--c-green) 40%, transparent)',
    background: 'color-mix(in srgb, var(--c-green) 13%, transparent)',
    color: 'var(--c-green)',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
};
