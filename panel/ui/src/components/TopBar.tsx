import type { HostEntry, HostStatus } from '../hooks/useHosts.ts';
import type { ConnectionState } from '../api/transport.ts';
import { useRole } from '../contexts/RoleContext.ts';
import { useTheme, THEMES } from '../contexts/ThemeContext.tsx';

interface Props {
  hostname: string;
  activeHost: HostEntry | null;
  remoteStatus: HostStatus;
  connState: ConnectionState;
  suActive: boolean;
  user: string;
  localIp: string;
  onSuperuserClick: () => void;
  onLogout: () => void;
  onToggleNav: () => void;
  onOpenPalette: () => void;
}

interface GatewayHealth {
  version: string;
  uptime_secs: number;
  sessions: number;
}

function fmtUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600) % 24;
  const d = Math.floor(secs / 86400);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h ${Math.floor(secs / 60) % 60}m`;
}

export function TopBar({
  hostname, activeHost, remoteStatus, connState,
  suActive, user, localIp, onSuperuserClick, onLogout, onToggleNav, onOpenPalette,
}: Props) {
  const role = useRole();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const { theme, setTheme } = useTheme();
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [sessionOpen, setSessionOpen] = React.useState(false);
  const [health, setHealth] = React.useState<GatewayHealth | null>(null);
  const helpRef = React.useRef<HTMLDivElement>(null);
  const sessionRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const fetchHealth = () => {
      const sessionId = sessionStorage.getItem('session_id') ?? '';
      fetch('/api/health', { headers: { 'Authorization': `Bearer ${sessionId}` } })
        .then(r => r.ok ? r.json() : null)
        .then(d => d && setHealth(d))
        .catch(() => {});
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 60_000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
      if (sessionRef.current && !sessionRef.current.contains(e.target as Node)) setSessionOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isRemote = !!activeHost && !activeHost.is_local;
  const originLabel = isRemote ? 'remote' : 'Panel';
  const originColor = isRemote ? 'var(--c-blue)' : 'var(--c-green)';
  const hostGlyph = isRemote ? '🌐' : '🖥️';
  const displayIp = isRemote ? (activeHost?.remote_ip ?? '') : localIp;

  const dotColor = remoteStatus === 'ok' ? 'var(--c-green)' : remoteStatus === 'error' ? 'var(--c-red)' : 'var(--text-3)';
  const connColor = connState === 'connected' ? 'var(--c-green)' : connState === 'reconnecting' ? 'var(--c-yellow)' : 'var(--c-red)';
  const connLabel = connState === 'connected' ? '● Connected' : connState === 'reconnecting' ? '◌ Reconnecting…' : '○ Disconnected';

  return (
    <header style={S.topBar}>
      <div style={S.topLeft}>
        <button className="nav-toggle" onClick={onToggleNav} aria-label="Toggle menu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span style={S.hostIcon}>{hostGlyph}</span>
        {displayIp && <span style={S.hostIp}>{displayIp}</span>}
        <span style={S.hostName}>
          {activeHost ? activeHost.name : hostname || '…'}
        </span>
        {activeHost && (
          <>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              marginLeft: '0.4rem', background: dotColor,
              boxShadow: remoteStatus !== 'unknown' ? `0 0 4px ${dotColor}` : 'none',
            }} title={remoteStatus === 'ok' ? 'Connected' : remoteStatus === 'error' ? 'Connection failed' : 'Connecting…'} />
            <span style={{ fontSize: '0.7rem', color: originColor, marginLeft: '0.3rem' }}>{originLabel}</span>
          </>
        )}
      </div>
      <div style={S.topRight}>
        {activeHost && (
          <button
            className="top-btn"
            onClick={onOpenPalette}
            title="Command palette"
            style={{ ...S.topBtn, display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            🔍 <span style={S.searchLabel}>Search</span>
            <kbd style={S.kbd}>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
        )}
        <button
          onClick={onSuperuserClick}
          style={{
            ...S.topBtn,
            background: suActive ? 'color-mix(in srgb, var(--c-green) 13%, transparent)' : 'color-mix(in srgb, var(--c-red) 13%, transparent)',
            color: suActive ? 'var(--c-green)' : 'var(--c-red)',
            borderColor: suActive ? 'color-mix(in srgb, var(--c-green) 27%, transparent)' : 'color-mix(in srgb, var(--c-red) 27%, transparent)',
          }}
        >
          {suActive ? '🔓 Administrative access' : '🔒 Limited access'}
        </button>

        <div ref={helpRef} style={S.dropdownWrap}>
          <button className="top-btn" onClick={() => { setHelpOpen(!helpOpen); setSessionOpen(false); }}>
            ❓ Help
          </button>
          {helpOpen && (
            <div style={S.dropdown}>
              <div style={S.dropdownTitle}>Tenodera</div>
              <Row label="Version"  value={health?.version ?? '…'} />
              <Row label="Uptime"   value={health ? fmtUptime(health.uptime_secs) : '…'} />
              <Row label="Sessions" value={health ? String(health.sessions) : '…'} />
              <hr style={S.hr} />
              <Row label="Status" value={connLabel} valueStyle={{ color: connColor }} />
              <Row label="Superuser" value={suActive ? 'Active' : 'Inactive'}
                valueStyle={{ color: suActive ? 'var(--c-green)' : 'var(--c-red)' }} />
            </div>
          )}
        </div>

        {role === 'readonly' && (
          <span style={{ fontSize: '0.7rem', padding: '2px 7px', borderRadius: 4, background: 'color-mix(in srgb, var(--c-yellow) 13%, transparent)', color: 'var(--c-yellow)', border: '1px solid color-mix(in srgb, var(--c-yellow) 27%, transparent)' }}>
            read-only
          </span>
        )}
        <div ref={sessionRef} style={S.dropdownWrap}>
          <button className="top-btn" onClick={() => { setSessionOpen(!sessionOpen); setHelpOpen(false); }}>
            👤 {user}
          </button>
          {sessionOpen && (
            <div style={S.dropdown}>
              <div style={S.dropdownTitle}>Session</div>
              <Row label="User" value={user} />
              <Row label="Role" value={role === 'admin' ? 'Admin' : 'Read-only'}
                valueStyle={{ color: role === 'admin' ? 'var(--c-green)' : 'var(--c-yellow)' }} />
              <Row label="Privileges" value={suActive ? 'Administrative' : 'Limited'}
                valueStyle={{ color: suActive ? 'var(--c-green)' : 'var(--text-2)' }} />
              <hr style={S.hr} />
              <div style={{ padding: '0.35rem 1rem 0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Theme</span>
                <select
                  value={theme}
                  onChange={e => setTheme(e.target.value as typeof theme)}
                  style={{
                    background: 'var(--bg-input)', color: 'var(--text-1)',
                    border: '1px solid var(--border-2)', borderRadius: 4,
                    fontSize: '0.82rem', padding: '0.28rem 0.5rem', cursor: 'pointer',
                    flex: 1,
                  }}
                >
                  {THEMES.map(t => (
                    <option key={t.name} value={t.name}>
                      {t.dark ? '🌙' : '☀️'} {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <hr style={S.hr} />
              <button onClick={onLogout} style={S.logoutBtn}>Log Out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function Row({ label, value, valueStyle }: { label: string; value: string; valueStyle?: React.CSSProperties }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  );
}

import React from 'react';

const S: Record<string, React.CSSProperties> = {
  topBar: {
    height: 50, minHeight: 50,
    background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-1)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 1.1rem', zIndex: 100,
  },
  topLeft: { display: 'flex', alignItems: 'center', gap: '0.5rem' },
  hostIcon: { fontSize: '0.95rem' },
  hostName: { fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-1)' },
  hostIp: {
    fontSize: '0.82rem', fontFamily: 'ui-monospace, monospace', fontWeight: 600,
    color: 'var(--c-cyan)', letterSpacing: '0.01em',
  },
  topRight: { display: 'flex', alignItems: 'center', gap: '0.45rem' },
  topBtn: {
    padding: '0.35rem 0.7rem', borderRadius: 6,
    border: '1px solid var(--border-1)', background: 'transparent',
    color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap',
    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
  },
  searchLabel: { color: 'var(--text-2)' },
  kbd: {
    fontSize: '0.66rem', color: 'var(--text-3)',
    border: '1px solid var(--border-1)', borderRadius: 4,
    padding: '0.05rem 0.32rem', background: 'var(--bg-app)',
  },
  dropdownWrap: { position: 'relative' },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
    background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 9,
    padding: '0.7rem 0', minWidth: 250, zIndex: 200,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  dropdownTitle: {
    padding: '0.35rem 1rem 0.55rem', fontSize: '0.9rem', fontWeight: 700,
    color: 'var(--text-1)', borderBottom: '1px solid var(--border-1)', marginBottom: '0.35rem',
  },
  row: { display: 'flex', justifyContent: 'space-between', padding: '0.38rem 1rem', fontSize: '0.85rem', color: 'var(--text-1)' },
  rowLabel: { color: 'var(--text-2)' },
  hr: { border: 'none', borderTop: '1px solid var(--border-1)', margin: '0.45rem 0' },
  logoutBtn: {
    width: '100%', padding: '0.5rem 1rem', border: 'none',
    background: 'transparent', color: 'var(--c-red)',
    fontSize: '0.9rem', fontWeight: 600, textAlign: 'left', cursor: 'pointer',
  },
};
