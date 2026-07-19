import { useNavigate, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { useContext } from 'react';
import React from 'react';
import { SuperuserContext } from '../api/SuperuserContext.tsx';
import { Icon } from './Icons.tsx';
import { NAV_SECTIONS, ADMIN_ITEMS, SUBNAV, type NavItem } from '../nav.ts';
import type { HostEntry, HostStatus } from '../hooks/useHosts.ts';
import type { ConnectionState } from '../api/transport.ts';

interface Props {
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  hostStatuses: Record<string, HostStatus>;
  connState: ConnectionState;
  open: boolean;
  onSwitchHost: (host: HostEntry | null) => void;
  onOpenManageHosts: () => void;
  onClose: () => void;
}

function NavRow({
  item, admin, onClose, currentPath, currentTab, onNavigateSub,
}: {
  item: NavItem;
  admin?: boolean;
  onClose: () => void;
  currentPath: string;
  currentTab: string | null;
  onNavigateSub: (path: string, id: string, defaultId: string) => void;
}) {
  const subItems = SUBNAV[item.path];
  const showSub = subItems && currentPath === item.path;
  const activeSub = currentTab ?? subItems?.[0]?.id;

  return (
    <li>
      <NavLink
        to={item.path}
        end={item.path === '/'}
        onClick={onClose}
        className={({ isActive }) =>
          `nav-link${admin ? ' nav-link--admin' : ''}${isActive ? ' active' : ''}`
        }
      >
        <span className="nav-icon"><Icon name={item.icon} size={18} /></span>
        {item.label}
      </NavLink>
      {showSub && (
        <ul className="nav-sub">
          {subItems!.map((s) => (
            <li key={s.id}>
              <button
                className={`nav-sublink${admin ? ' nav-sublink--admin' : ''}${activeSub === s.id ? ' active' : ''}`}
                onClick={() => onNavigateSub(item.path, s.id, subItems![0].id)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({
  hosts, activeHost, hostStatuses, connState, open,
  onSwitchHost, onOpenManageHosts, onClose,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const currentTab = searchParams.get('tab');
  const su = useContext(SuperuserContext);
  const [hostSelectorOpen, setHostSelectorOpen] = React.useState(false);
  const hostSelectorRef = React.useRef<HTMLDivElement>(null);

  const handleNavigateSub = (path: string, id: string, defaultId: string) => {
    navigate(id === defaultId ? path : `${path}?tab=${id}`);
    onClose();
  };

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (hostSelectorRef.current && !hostSelectorRef.current.contains(e.target as Node))
        setHostSelectorOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const connColor = connState === 'connected' ? 'var(--c-green)' : connState === 'reconnecting' ? 'var(--c-yellow)' : 'var(--c-red)';
  const connLabel = connState === 'connected' ? '● Connected' : connState === 'reconnecting' ? '◌ Reconnecting…' : '○ Disconnected';

  return (
    <nav className={`sidebar${open ? ' open' : ''}`}>
      <div
        className="sidebar-logo"
        onClick={() => { navigate('/'); onClose(); }}
        role="button"
        tabIndex={0}
        style={{ marginBottom: '0.5rem' }}
      >
        <img src="/tenodera_icon.webp" alt="Tenodera" style={S.logoImg} />
        Tenodera
      </div>
      <div style={{ ...S.status, color: connColor }}>{connLabel}</div>

      {/* ── Host Selector ── */}
      <div ref={hostSelectorRef} style={S.hostSelector}>
        <button
          className="host-selector-btn"
          style={{ borderColor: activeHost ? 'var(--c-blue)' : 'var(--border-1)' }}
          onClick={() => setHostSelectorOpen(!hostSelectorOpen)}
        >
          <span style={{ display: 'inline-flex', flexShrink: 0, color: activeHost && !activeHost.is_local ? 'var(--c-blue)' : 'var(--text-2)' }}>
            <Icon name={activeHost && !activeHost.is_local ? 'globe' : 'monitor'} size={16} />
          </span>
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeHost ? activeHost.name : 'Select host…'}
          </span>
          <Icon name="chevronDown" size={14} style={{ opacity: 0.6 }} />
        </button>
        {hostSelectorOpen && (
          <div style={S.hostDropdown}>
            {hosts.map((h) => {
              const st = hostStatuses[h.id] ?? 'unknown';
              return (
                <HostOption
                  key={h.id}
                  dot={st === 'ok' ? 'var(--c-green)' : st === 'error' ? 'var(--c-red)' : 'var(--text-3)'}
                  isActive={activeHost?.id === h.id}
                  activeColor={h.is_local ? 'var(--c-green)' : 'var(--c-blue)'}
                  onClick={() => { onSwitchHost(h); setHostSelectorOpen(false); }}
                  name={h.is_local ? `${h.name} (local)` : h.name}
                  addr={h.is_local ? 'this panel host' : (h.online ? 'online' : 'offline')}
                />
              );
            })}
            <div style={S.divider} />
            <div
              className="host-option"
              style={{ color: 'var(--c-blue)', justifyContent: 'center' }}
              onClick={() => { setHostSelectorOpen(false); onOpenManageHosts(); }}
            >
              <Icon name="settings" size={15} /> Manage hosts…
            </div>
          </div>
        )}
      </div>

      {/* ── Nav ── */}
      <ul className="nav-list">
        {NAV_SECTIONS.map((section) => (
          <li className="nav-section" key={section.label}>
            <div className="nav-section-label">{section.label}</div>
            <ul className="nav-section-items">
              {section.items.map((item) => (
                <NavRow
                  key={item.path}
                  item={item}
                  onClose={onClose}
                  currentPath={location.pathname}
                  currentTab={currentTab}
                  onNavigateSub={handleNavigateSub}
                />
              ))}
            </ul>
          </li>
        ))}

        {/* Admin section — visible only when superuser is active */}
        {su.active && (
          <li className="nav-section">
            <div className="nav-section-label">Admin</div>
            <ul className="nav-section-items">
              {ADMIN_ITEMS.map((item) => (
                <NavRow
                  key={item.path}
                  item={item}
                  admin
                  onClose={onClose}
                  currentPath={location.pathname}
                  currentTab={currentTab}
                  onNavigateSub={handleNavigateSub}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </nav>
  );
}

function HostOption({
  dot, isActive, activeColor = 'var(--c-green)', onClick, name, addr,
}: {
  dot: string; isActive: boolean; activeColor?: string;
  onClick: () => void; name: string; addr: string;
}) {
  return (
    <div
      className="host-option"
      style={{
        background: isActive ? `color-mix(in srgb, ${activeColor} 13%, transparent)` : undefined,
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

const S: Record<string, React.CSSProperties> = {
  logoImg: { width: '32px', height: '32px', objectFit: 'contain' },
  status: { fontSize: '0.75rem', color: 'var(--text-2)', marginBottom: '0.75rem', paddingLeft: '0.35rem' },
  hostSelector: { position: 'relative', marginBottom: '1rem' },
  hostDropdown: {
    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
    background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 8,
    padding: '0.3rem 0', zIndex: 300, maxHeight: 290, overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  hostName: { fontWeight: 600, fontSize: '0.85rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  hostAddr: { fontSize: '0.7rem', color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  divider: { height: 1, background: 'var(--border-1)', margin: '0.25rem 0' },
};
