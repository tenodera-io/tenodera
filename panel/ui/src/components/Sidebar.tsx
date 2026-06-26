import { useNavigate, NavLink } from 'react-router-dom';
import type { HostEntry, HostStatus } from '../hooks/useHosts.ts';
import type { ConnectionState } from '../api/transport.ts';

interface Props {
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  hostStatuses: Record<string, HostStatus>;
  connState: ConnectionState;
  onSwitchHost: (host: HostEntry | null) => void;
  onOpenManageHosts: () => void;
}

const NAV_SECTIONS = [
  {
    label: 'System',
    items: [
      { path: '/', label: 'Dashboard', icon: '📊' },
      { path: '/services', label: 'Services', icon: '⚙️' },
      { path: '/containers', label: 'Virtual machines', icon: '📦' },
      { path: '/storage', label: 'Storage', icon: '💾' },
      { path: '/networking', label: 'Networking', icon: '🌐' },
      { path: '/packages', label: 'Packages', icon: '📦' },
      { path: '/users', label: 'Users', icon: '👤' },
      { path: '/cron', label: 'Cron Jobs', icon: '⏰' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { path: '/logs', label: 'Logs', icon: '📜' },
      { path: '/log-files', label: 'Log Files', icon: '🗒️' },
      { path: '/terminal', label: 'Terminal', icon: '🖥️' },
      { path: '/files', label: 'Files', icon: '📁' },
      { path: '/kdump', label: 'Kernel Dump', icon: '💥' },
    ],
  },
];

export function Sidebar({
  hosts, activeHost, hostStatuses, connState,
  onSwitchHost, onOpenManageHosts,
}: Props) {
  const navigate = useNavigate();
  const [hostSelectorOpen, setHostSelectorOpen] = React.useState(false);
  const hostSelectorRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (hostSelectorRef.current && !hostSelectorRef.current.contains(e.target as Node))
        setHostSelectorOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const connColor = connState === 'connected' ? '#9ece6a' : connState === 'reconnecting' ? '#e0af68' : '#f7768e';
  const connLabel = connState === 'connected' ? '● Connected' : connState === 'reconnecting' ? '◌ Reconnecting…' : '○ Disconnected';

  const visibleHosts = hosts;

  return (
    <nav style={S.sidebar}>
      <div style={S.logo} onClick={() => navigate('/')} role="button" tabIndex={0}>
        <img src="/tenodera_icon.webp" alt="Tenodera" style={S.logoImg} />
        Tenodera
      </div>
      <div style={{ ...S.status, color: connColor }}>{connLabel}</div>

      {/* ── Host Selector ── */}
      <div ref={hostSelectorRef} style={S.hostSelector}>
        <button
          style={{ ...S.hostSelectorBtn, borderColor: activeHost ? '#7aa2f7' : 'var(--border)' }}
          onClick={() => setHostSelectorOpen(!hostSelectorOpen)}
        >
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeHost ? (activeHost.is_local ? `🖥️ ${activeHost.name}` : `🌐 ${activeHost.name}`) : '🖥️ Select host…'}
          </span>
          <span style={{ fontSize: '0.65rem', opacity: 0.6 }}>▼</span>
        </button>
        {hostSelectorOpen && (
          <div style={S.hostDropdown}>
            {visibleHosts.map((h) => {
              const st = hostStatuses[h.id] ?? 'unknown';
              return (
                <HostOption
                  key={h.id}
                  dot={st === 'ok' ? '#9ece6a' : st === 'error' ? '#f7768e' : '#565f89'}
                  isActive={activeHost?.id === h.id}
                  activeColor={h.is_local ? '#9ece6a' : '#7aa2f7'}
                  onClick={() => { onSwitchHost(h); setHostSelectorOpen(false); }}
                  name={h.is_local ? `${h.name} (local)` : h.name}
                  addr={h.is_local ? 'this panel host' : (h.online ? 'online' : 'offline')}
                />
              );
            })}
            <div style={S.divider} />
            <div
              style={{ ...S.hostOption, color: 'var(--accent)', justifyContent: 'center' }}
              onClick={() => { setHostSelectorOpen(false); onOpenManageHosts(); }}
            >
              ⚙ Manage hosts…
            </div>
          </div>
        )}
      </div>

      {/* ── Nav ── */}
      <ul style={S.navList}>
        {NAV_SECTIONS.map((section, si) => (
          <li key={section.label}>
            <div style={{ ...S.sectionDivider, ...(si === 0 ? { marginTop: 0 } : {}) }} />
            <div style={S.sectionLabel}>{section.label}</div>
            <ul style={S.sectionList}>
              {section.items.map(({ path, label, icon }) => (
                <li key={path}>
                  <NavLink
                    to={path} end={path === '/'}
                    style={({ isActive }) => ({
                      ...S.navLink,
                      background: isActive ? 'var(--bg-card)' : 'transparent',
                      borderLeft: isActive ? '3px solid #9ece6a' : '3px solid transparent',
                    })}
                  >
                    <span style={S.navIcon}>{icon}</span>{label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function HostOption({
  dot, isActive, activeColor = '#9ece6a', onClick, name, addr,
}: {
  dot: string; isActive: boolean; activeColor?: string;
  onClick: () => void; name: string; addr: string;
}) {
  return (
    <div
      style={{
        ...S.hostOption,
        background: isActive ? `${activeColor}22` : 'transparent',
        borderLeft: isActive ? `3px solid ${activeColor}` : '3px solid transparent',
      }}
      onClick={onClick}
    >
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
        background: dot, boxShadow: `0 0 4px ${dot}`, flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={S.hostName}>{name}</div>
        <div style={S.hostAddr}>{addr}</div>
      </div>
    </div>
  );
}

import React from 'react';

const S: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '220px', minWidth: '220px',
    background: 'var(--bg-secondary)', padding: '1rem',
    display: 'flex', flexDirection: 'column',
    borderRight: '1px solid var(--border)', overflowY: 'auto',
  },
  logo: {
    fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem',
    color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer',
  },
  logoImg: { width: '32px', height: '32px', objectFit: 'contain' },
  status: { fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' },
  hostSelector: { position: 'relative', marginBottom: '0.75rem' },
  hostSelectorBtn: {
    width: '100%', display: 'flex', alignItems: 'center', gap: '0.4rem',
    padding: '0.45rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg-primary)', color: 'var(--text-primary)',
    fontSize: '0.82rem', cursor: 'pointer',
  },
  hostDropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
    background: '#1a1b26', border: '1px solid #292e42', borderRadius: 8,
    padding: '0.3rem 0', zIndex: 300, maxHeight: 290, overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  hostOption: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.45rem 0.6rem', cursor: 'pointer',
    fontSize: '0.82rem', color: 'var(--text-primary)',
  },
  hostName: { fontWeight: 600, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  hostAddr: { fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  divider: { height: 1, background: '#292e42', margin: '0.25rem 0' },
  navList: { listStyle: 'none', flex: 1, display: 'flex', flexDirection: 'column', gap: 0 },
  sectionDivider: { height: '1px', background: '#414868', marginTop: '0.75rem', marginBottom: '0.5rem' },
  sectionLabel: {
    fontSize: '0.7rem', fontWeight: 700, color: '#a9b1d6',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    padding: '0 0.75rem', marginBottom: '0.35rem',
  },
  sectionList: { listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.15rem' },
  navLink: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.5rem 0.75rem', borderRadius: '4px',
    color: 'var(--text-primary)', textDecoration: 'none', fontSize: '0.9rem',
  },
  navIcon: { fontSize: '1rem', width: '1.4rem', textAlign: 'center' },
};
