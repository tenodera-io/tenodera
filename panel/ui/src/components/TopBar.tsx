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
  onSuperuserClick: () => void;
  onLogout: () => void;
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
  suActive, user, onSuperuserClick, onLogout,
}: Props) {
  const role = useRole();
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

  const dotColor = remoteStatus === 'ok' ? 'var(--c-green)' : remoteStatus === 'error' ? 'var(--c-red)' : 'var(--text-3)';
  const connColor = connState === 'connected' ? 'var(--c-green)' : connState === 'reconnecting' ? 'var(--c-yellow)' : 'var(--c-red)';
  const connLabel = connState === 'connected' ? '● Connected' : connState === 'reconnecting' ? '◌ Reconnecting…' : '○ Disconnected';

  return (
    <header style={S.topBar}>
      <div style={S.topLeft}>
        <span style={S.hostIcon}>{activeHost ? '🌐' : '🖥️'}</span>
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
            <span style={{ fontSize: '0.7rem', color: 'var(--c-blue)', marginLeft: '0.3rem' }}>remote</span>
          </>
        )}
      </div>
      <div style={S.topRight}>
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
          <button onClick={() => { setHelpOpen(!helpOpen); setSessionOpen(false); }} style={S.topBtn}>
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
          <button onClick={() => { setSessionOpen(!sessionOpen); setHelpOpen(false); }} style={S.topBtn}>
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
              <div style={{ padding: '0.3rem 0.9rem 0.4rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Theme</span>
                <select
                  value={theme}
                  onChange={e => setTheme(e.target.value as typeof theme)}
                  style={{
                    background: 'var(--bg-input)', color: 'var(--text-1)',
                    border: '1px solid var(--border-2)', borderRadius: 4,
                    fontSize: '0.75rem', padding: '0.2rem 0.4rem', cursor: 'pointer',
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
    height: 40, minHeight: 40,
    background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-1)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 1rem', zIndex: 100,
  },
  topLeft: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  hostIcon: { fontSize: '0.9rem' },
  hostName: { fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-1)' },
  topRight: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  topBtn: {
    padding: '0.25rem 0.65rem', borderRadius: 4,
    border: '1px solid var(--border-1)', background: 'transparent',
    color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.78rem', whiteSpace: 'nowrap',
  },
  dropdownWrap: { position: 'relative' },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
    background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 8,
    padding: '0.6rem 0', minWidth: 220, zIndex: 200,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  dropdownTitle: {
    padding: '0.3rem 0.9rem 0.5rem', fontSize: '0.8rem', fontWeight: 700,
    color: 'var(--text-1)', borderBottom: '1px solid var(--border-1)', marginBottom: '0.3rem',
  },
  row: { display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0.9rem', fontSize: '0.78rem', color: 'var(--text-1)' },
  rowLabel: { color: 'var(--text-2)' },
  hr: { border: 'none', borderTop: '1px solid var(--border-1)', margin: '0.4rem 0' },
  logoutBtn: {
    width: '100%', padding: '0.4rem 0.9rem', border: 'none',
    background: 'transparent', color: 'var(--c-red)',
    fontSize: '0.8rem', fontWeight: 600, textAlign: 'left', cursor: 'pointer',
  },
};
