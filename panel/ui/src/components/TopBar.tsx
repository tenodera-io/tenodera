import type { HostEntry, HostStatus } from '../hooks/useHosts.ts';
import type { ConnectionState } from '../api/transport.ts';

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

export function TopBar({
  hostname, activeHost, remoteStatus, connState,
  suActive, user, onSuperuserClick, onLogout,
}: Props) {
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [sessionOpen, setSessionOpen] = React.useState(false);
  const helpRef = React.useRef<HTMLDivElement>(null);
  const sessionRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
      if (sessionRef.current && !sessionRef.current.contains(e.target as Node)) setSessionOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const dotColor = remoteStatus === 'ok' ? '#9ece6a' : remoteStatus === 'error' ? '#f7768e' : '#565f89';
  const connColor = connState === 'connected' ? '#9ece6a' : connState === 'reconnecting' ? '#e0af68' : '#f7768e';
  const connLabel = connState === 'connected' ? '● Connected' : connState === 'reconnecting' ? '◌ Reconnecting…' : '○ Disconnected';

  return (
    <header style={S.topBar}>
      <div style={S.topLeft}>
        <span style={S.hostIcon}>{activeHost ? '🌐' : '🖥️'}</span>
        <span style={S.hostName}>
          {activeHost ? `${activeHost.name} (${activeHost.address})` : hostname || '…'}
        </span>
        {activeHost && (
          <>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              marginLeft: '0.4rem', background: dotColor,
              boxShadow: remoteStatus !== 'unknown' ? `0 0 4px ${dotColor}` : 'none',
            }} title={remoteStatus === 'ok' ? 'Connected' : remoteStatus === 'error' ? 'Connection failed' : 'Connecting…'} />
            <span style={{ fontSize: '0.7rem', color: '#7aa2f7', marginLeft: '0.3rem' }}>remote</span>
          </>
        )}
      </div>
      <div style={S.topRight}>
        <button
          onClick={onSuperuserClick}
          style={{
            ...S.topBtn,
            background: suActive ? '#9ece6a22' : '#f7768e22',
            color: suActive ? '#9ece6a' : '#f7768e',
            borderColor: suActive ? '#9ece6a44' : '#f7768e44',
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
              <Row label="Version" value="0.1.0" />
              <Row label="Backend" value="Rust + Axum" />
              <Row label="Frontend" value="React 19" />
              <hr style={S.hr} />
              <Row label="Status" value={connLabel} valueStyle={{ color: connColor }} />
              <Row label="Superuser" value={suActive ? 'Active' : 'Inactive'}
                valueStyle={{ color: suActive ? '#9ece6a' : '#f7768e' }} />
            </div>
          )}
        </div>

        <div ref={sessionRef} style={S.dropdownWrap}>
          <button onClick={() => { setSessionOpen(!sessionOpen); setHelpOpen(false); }} style={S.topBtn}>
            👤 {user}
          </button>
          {sessionOpen && (
            <div style={S.dropdown}>
              <div style={S.dropdownTitle}>Session</div>
              <Row label="User" value={user} />
              <Row label="Host" value={hostname} />
              <Row label="Privileges" value={suActive ? 'Administrative' : 'Limited'}
                valueStyle={{ color: suActive ? '#9ece6a' : 'var(--text-secondary)' }} />
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
    background: '#0d1117', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 1rem', zIndex: 100,
  },
  topLeft: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  hostIcon: { fontSize: '0.9rem' },
  hostName: { fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' },
  topRight: { display: 'flex', alignItems: 'center', gap: '0.4rem' },
  topBtn: {
    padding: '0.25rem 0.65rem', borderRadius: 4,
    border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.78rem', whiteSpace: 'nowrap',
  },
  dropdownWrap: { position: 'relative' },
  dropdown: {
    position: 'absolute', top: 'calc(100% + 6px)', right: 0,
    background: '#1a1b26', border: '1px solid #292e42', borderRadius: 8,
    padding: '0.6rem 0', minWidth: 220, zIndex: 200,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  dropdownTitle: {
    padding: '0.3rem 0.9rem 0.5rem', fontSize: '0.8rem', fontWeight: 700,
    color: 'var(--text-primary)', borderBottom: '1px solid #292e42', marginBottom: '0.3rem',
  },
  row: { display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0.9rem', fontSize: '0.78rem', color: 'var(--text-primary)' },
  rowLabel: { color: 'var(--text-secondary)' },
  hr: { border: 'none', borderTop: '1px solid #292e42', margin: '0.4rem 0' },
  logoutBtn: {
    width: '100%', padding: '0.4rem 0.9rem', border: 'none',
    background: 'transparent', color: '#f7768e',
    fontSize: '0.8rem', fontWeight: 600, textAlign: 'left', cursor: 'pointer',
  },
};
