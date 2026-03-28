import { useEffect, useState, useRef, useMemo, createContext, useContext, useCallback } from 'react';
import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { connect, disconnect, request, openChannel, type Message } from '../api/transport.ts';
import { HostTransportProvider } from '../api/HostTransportContext.tsx';
import { saveSuperuserPassword, loadSuperuserPassword, clearSuperuserPassword } from '../api/secureStorage.ts';
import { Dashboard } from './Dashboard.tsx';
import { Services } from './Services.tsx';
import { Logs } from './Logs.tsx';
import { Terminal } from './Terminal.tsx';
import { Files } from './Files.tsx';
import { Containers } from './Containers.tsx';
import { Storage } from './Storage.tsx';
import { Networking } from './Networking.tsx';
import { Packages } from './Packages.tsx';
import { Hosts } from './Hosts.tsx';
import { Kdump } from './Kdump.tsx';
import { LogFiles } from './LogFiles.tsx';
import { Users } from './Users.tsx';

/* ── Superuser context ─────────────────────────────────── */

interface SuperuserCtx {
  active: boolean;
  password: string;
}
const SuperuserContext = createContext<SuperuserCtx>({ active: false, password: '' });
export function useSuperuser() { return useContext(SuperuserContext); }

/* ── types ─────────────────────────────────────────────── */

interface ShellProps {
  sessionId: string;
  user: string;
  onLogout: () => void;
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

/* ── host type ─────────────────────────────────────────── */

interface HostEntry {
  id: string;
  name: string;
  address: string;
  user: string;
  ssh_port: number;
}

const TOP_BAR_H = 40;

/* ── component ─────────────────────────────────────────── */

export function Shell({ sessionId: _sessionId, user, onLogout }: ShellProps) {
  const [connected, setConnected] = useState(false);
  const [hostname, setHostname] = useState('');
  const navigate = useNavigate();

  /* ── active host context (null = local) ── */
  const [activeHost, setActiveHost] = useState<HostEntry | null>(null);
  const pendingHostId = useRef<string | null>(sessionStorage.getItem('active_host_id'));
  const [hostRestored, setHostRestored] = useState(!pendingHostId.current);
  const [hosts, setHosts]           = useState<HostEntry[]>([]);
  const [hostSelectorOpen, setHostSelectorOpen] = useState(false);
  const [hostManageOpen, setHostManageOpen]     = useState(false);
  const hostSelectorRef = useRef<HTMLDivElement>(null);
  const [remoteStatus, setRemoteStatus] = useState<'unknown' | 'ok' | 'error'>('unknown');
  const [hostStatuses, setHostStatuses] = useState<Record<string, 'unknown' | 'ok' | 'error'>>({});

  /* superuser state – password encrypted in sessionStorage via Web Crypto (HTTPS only) */
  const [suActive, setSuActive] = useState(false);
  const [suPassword, setSuPassword] = useState('');
  const suRestoredRef = useRef(false);
  const [suPrompt, setSuPrompt] = useState(false);
  const [suPwInput, setSuPwInput] = useState('');
  const [suError, setSuError] = useState('');

  /* dropdown state */
  const [helpOpen, setHelpOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<HTMLDivElement>(null);

  /* ── load hosts list ── */
  const loadHosts = useCallback(() => {
    const ch = openChannel('hosts.manage');
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as { action?: string; hosts?: HostEntry[] };
        if (d.action === 'list' && d.hosts) {
          setHosts(d.hosts);
          /* restore previously-selected host after refresh */
          const savedId = pendingHostId.current;
          if (savedId) {
            const match = d.hosts.find((h: HostEntry) => h.id === savedId);
            if (match) setActiveHost(match);
            pendingHostId.current = null;
          }
          setHostRestored(true);
        }
      }
    });
    ch.send({ action: 'list' });
    // close the channel after a short delay so the response arrives
    setTimeout(() => ch.close(), 2000);
  }, []);

  /* ── restore superuser state from encrypted storage on mount ── */
  useEffect(() => {
    if (suRestoredRef.current) return;
    suRestoredRef.current = true;
    if (sessionStorage.getItem('su_active') !== '1') return;
    loadSuperuserPassword().then((pw) => {
      if (pw) {
        setSuActive(true);
        setSuPassword(pw);
      } else {
        /* password could not be decrypted (HTTP fallback or corrupt) — reset */
        sessionStorage.removeItem('su_active');
      }
    });
  }, []);

  useEffect(() => {
    connect()
      .then(() => {
        setConnected(true);
        request('system.info').then((results) => {
          const info = results[0] as { hostname?: string } | undefined;
          if (info?.hostname) setHostname(info.hostname);
        });
        loadHosts();
      })
      .catch((err) => {
        console.error('WebSocket connection failed:', err);
        setConnected(false);
      });

    return () => disconnect();
  }, [loadHosts]);

  /* ── poll hosts list every 5s ── */
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(loadHosts, 5000);
    return () => clearInterval(interval);
  }, [connected, loadHosts]);

  /* ── switch active host ── */
  const switchHost = useCallback((host: HostEntry | null) => {
    setActiveHost(host);
    if (host) {
      sessionStorage.setItem('active_host_id', host.id);
    } else {
      sessionStorage.removeItem('active_host_id');
    }
    setHostSelectorOpen(false);
    setRemoteStatus('unknown');
    navigate('/');
  }, [navigate]);

  /* ── probe remote host connectivity ── */
  useEffect(() => {
    if (!activeHost || !connected) {
      setRemoteStatus('unknown');
      return;
    }
    setRemoteStatus('unknown');
    request('system.info', { host: activeHost.id })
      .then(() => setRemoteStatus('ok'))
      .catch(() => setRemoteStatus('error'));
  }, [activeHost, connected]);

  /* ── probe all hosts when dropdown opens (refresh every 1s) ── */
  useEffect(() => {
    if (!hostSelectorOpen || !connected || hosts.length === 0) return;
    const probe = () => {
      for (const h of hosts) {
        request('system.info', { host: h.id })
          .then(() => setHostStatuses((prev) => ({ ...prev, [h.id]: 'ok' })))
          .catch(() => setHostStatuses((prev) => ({ ...prev, [h.id]: 'error' })));
      }
    };
    probe();
    const interval = setInterval(probe, 1000);
    return () => clearInterval(interval);
  }, [hostSelectorOpen, connected, hosts]);

  /* close dropdowns on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
      if (sessionRef.current && !sessionRef.current.contains(e.target as Node)) setSessionOpen(false);
      if (hostSelectorRef.current && !hostSelectorRef.current.contains(e.target as Node)) setHostSelectorOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = () => {
    disconnect();
    sessionStorage.removeItem('su_active');
    sessionStorage.removeItem('active_host_id');
    clearSuperuserPassword(); /* remove encrypted password & key */
    onLogout();
    navigate('/login');
  };

  /* ── superuser toggle ── */
  const handleSuperuserClick = () => {
    if (suActive) {
      /* deactivate */
      setSuActive(false);
      setSuPassword('');
      sessionStorage.removeItem('su_active');
      clearSuperuserPassword(); /* remove encrypted password & key */
      return;
    }
    /* show password prompt */
    setSuPrompt(true);
    setSuPwInput('');
    setSuError('');
  };

  const handleSuperuserSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!suPwInput) {
      setSuError('Password required');
      return;
    }
    /* verify password by running sudo -S -k true via the bridge */
    const verifyPassword = async () => {
      try {
        const results = await request('superuser.verify', { password: suPwInput });
        const res = results[0] as { ok?: boolean; error?: string } | undefined;
        if (res?.ok) {
          setSuActive(true);
          setSuPassword(suPwInput);
          sessionStorage.setItem('su_active', '1');
          saveSuperuserPassword(suPwInput); /* encrypt & persist (no-op on HTTP) */
          setSuPrompt(false);
          setSuError('');
        } else {
          setSuError(res?.error || 'Authentication failed');
        }
      } catch {
        setSuError('Verification request failed');
      }
    };
    verifyPassword();
  };

  const suCtx = useMemo(() => ({ active: suActive, password: suPassword }), [suActive, suPassword]);

  return (
    <SuperuserContext.Provider value={suCtx}>
      <div style={S.wrapper}>
        {/* ── Top Bar ── */}
        <header style={S.topBar}>
          <div style={S.topLeft}>
            <span style={S.hostIcon}>{activeHost ? '🌐' : '🖥️'}</span>
            <span style={S.hostName}>
              {activeHost ? `${activeHost.name} (${activeHost.address})` : hostname || '…'}
            </span>
            {activeHost && (
              <>
                <span style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  marginLeft: '0.4rem',
                  background: remoteStatus === 'ok' ? '#9ece6a' : remoteStatus === 'error' ? '#f7768e' : '#565f89',
                  boxShadow: remoteStatus === 'ok' ? '0 0 4px #9ece6a' : remoteStatus === 'error' ? '0 0 4px #f7768e' : 'none',
                }} title={remoteStatus === 'ok' ? 'Connected' : remoteStatus === 'error' ? 'Connection failed' : 'Connecting…'} />
                <span style={{ fontSize: '0.7rem', color: '#7aa2f7', marginLeft: '0.3rem' }}>remote</span>
              </>
            )}
          </div>
          <div style={S.topRight}>
            {/* Limited access / Administrative access */}
            <button
              onClick={handleSuperuserClick}
              style={{
                ...S.topBtn,
                background: suActive ? '#9ece6a22' : '#f7768e22',
                color: suActive ? '#9ece6a' : '#f7768e',
                borderColor: suActive ? '#9ece6a44' : '#f7768e44',
              }}
            >
              {suActive ? '🔓 Administrative access' : '🔒 Limited access'}
            </button>

            {/* Help */}
            <div ref={helpRef} style={S.dropdownWrap}>
              <button onClick={() => { setHelpOpen(!helpOpen); setSessionOpen(false); }} style={S.topBtn}>
                ❓ Help
              </button>
              {helpOpen && (
                <div style={S.dropdown}>
                  <div style={S.dropdownTitle}>Tenodera</div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Version</span>
                    <span>0.1.0</span>
                  </div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Backend</span>
                    <span>Rust + Axum</span>
                  </div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Frontend</span>
                    <span>React 19</span>
                  </div>
                  <hr style={S.dropdownHr} />
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Status</span>
                    <span style={{ color: connected ? '#9ece6a' : '#f7768e' }}>
                      {connected ? '● Connected' : '○ Disconnected'}
                    </span>
                  </div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Superuser</span>
                    <span style={{ color: suActive ? '#9ece6a' : '#f7768e' }}>
                      {suActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Session */}
            <div ref={sessionRef} style={S.dropdownWrap}>
              <button onClick={() => { setSessionOpen(!sessionOpen); setHelpOpen(false); }} style={S.topBtn}>
                👤 {user}
              </button>
              {sessionOpen && (
                <div style={S.dropdown}>
                  <div style={S.dropdownTitle}>Session</div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>User</span>
                    <span>{user}</span>
                  </div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Host</span>
                    <span>{hostname}</span>
                  </div>
                  <div style={S.dropdownItem}>
                    <span style={S.dropdownLabel}>Privileges</span>
                    <span style={{ color: suActive ? '#9ece6a' : 'var(--text-secondary)' }}>
                      {suActive ? 'Administrative' : 'Limited'}
                    </span>
                  </div>
                  <hr style={S.dropdownHr} />
                  <button onClick={handleLogout} style={S.dropdownLogout}>
                    Log Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* ── Superuser password prompt modal ── */}
        {suPrompt && (
          <div style={S.modalOverlay} onClick={() => setSuPrompt(false)}>
            <form
              style={S.modal}
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleSuperuserSubmit}
            >
              <h3 style={S.modalTitle}>🔓 Switch to Administrative Access</h3>
              <p style={S.modalDesc}>
                Enter your password to enable superuser privileges. Actions like
                managing services and containers will use sudo automatically.
              </p>
              {suError && <div style={S.modalError}>{suError}</div>}
              <input
                type="password"
                placeholder="Password"
                value={suPwInput}
                onChange={(e) => setSuPwInput(e.target.value)}
                style={{ ...S.modalInput, borderColor: suPwInput ? '#7aa2f7' : '#9ece6a' }}
                autoFocus
                autoComplete="current-password"
              />
              <div style={S.modalActions}>
                <button
                  type="button"
                  onClick={() => setSuPrompt(false)}
                  style={S.modalCancelBtn}
                >
                  Cancel
                </button>
                <button type="submit" style={S.modalSubmitBtn}>
                  Authenticate
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── Body: sidebar + main ── */}
        <div style={S.body}>
          <nav style={S.sidebar}>
            <div style={S.logo} onClick={() => navigate('/')} role="button" tabIndex={0}>
              <img src="/tenodera_icon.png" alt="Tenodera" style={S.sidebarLogo} />
              Tenodera
            </div>
            <div style={{ ...S.status, color: connected ? '#9ece6a' : '#f7768e' }}>
              {connected ? '● Connected' : '○ Disconnected'}
            </div>

            {/* ── Host Selector ── */}
            <div ref={hostSelectorRef} style={S.hostSelector}>
              <button
                style={{
                  ...S.hostSelectorBtn,
                  borderColor: activeHost ? '#7aa2f7' : 'var(--border)',
                }}
                onClick={() => setHostSelectorOpen(!hostSelectorOpen)}
              >
                <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeHost ? `🌐 ${activeHost.name}` : `🖥️ ${hostname || 'Local'}`}
                </span>
                <span style={{ fontSize: '0.65rem', opacity: 0.6 }}>▼</span>
              </button>
              {hostSelectorOpen && (
                <div style={S.hostDropdown}>
                  <div
                    style={{
                      ...S.hostOption,
                      background: !activeHost ? '#9ece6a22' : 'transparent',
                      borderLeft: !activeHost ? '3px solid #9ece6a' : '3px solid transparent',
                    }}
                    onClick={() => switchHost(null)}
                  >
                    <span style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: connected ? '#9ece6a' : '#f7768e',
                      boxShadow: `0 0 4px ${connected ? '#9ece6a' : '#f7768e'}`,
                      flexShrink: 0,
                    }} title={connected ? 'Online' : 'Offline'} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={S.hostOptionName}>{hostname || 'Local'}</div>
                      <div style={S.hostOptionAddr}>localhost</div>
                    </div>
                  </div>
                  {hosts.length > 0 && <div style={S.hostDropdownDivider} />}
                  {hosts.map((h) => {
                    const st = hostStatuses[h.id] ?? 'unknown';
                    const dotColor = st === 'ok' ? '#9ece6a' : st === 'error' ? '#f7768e' : '#565f89';
                    return (
                    <div
                      key={h.id}
                      style={{
                        ...S.hostOption,
                        background: activeHost?.id === h.id ? '#7aa2f722' : 'transparent',
                        borderLeft: activeHost?.id === h.id ? '3px solid #7aa2f7' : '3px solid transparent',
                      }}
                      onClick={() => switchHost(h)}
                    >
                      <span style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: dotColor,
                        boxShadow: st !== 'unknown' ? `0 0 4px ${dotColor}` : 'none',
                        flexShrink: 0,
                      }} title={st === 'ok' ? 'Online' : st === 'error' ? 'Offline' : 'Checking…'} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={S.hostOptionName}>{h.name}</div>
                        <div style={S.hostOptionAddr}>{h.user || user}@{h.address}:{h.ssh_port}</div>
                      </div>
                    </div>
                    );
                  })}
                  <div style={S.hostDropdownDivider} />
                  <div
                    style={{ ...S.hostOption, color: 'var(--accent)', justifyContent: 'center' }}
                    onClick={() => { setHostSelectorOpen(false); setHostManageOpen(true); }}
                  >
                    ⚙ Manage hosts…
                  </div>
                </div>
              )}
            </div>

            <ul style={S.navList}>
              {NAV_SECTIONS.map((section, si) => (
                <li key={section.label}>
                  <div style={{ ...S.sectionDivider, ...(si === 0 ? { marginTop: 0 } : {}) }} />
                  <div style={S.sectionLabel}>{section.label}</div>
                  <ul style={S.sectionList}>
                    {section.items.map(({ path, label, icon }) => (
                      <li key={path}>
                        <NavLink
                          to={path}
                          end={path === '/'}
                          style={({ isActive }) => ({
                            ...S.navLink,
                            background: isActive ? 'var(--bg-card)' : 'transparent',
                            borderLeft: isActive ? '3px solid #9ece6a' : '3px solid transparent',
                            paddingLeft: isActive ? 'calc(0.75rem - 3px)' : 'calc(0.75rem - 3px)',
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
          <main style={S.main}>
            <HostTransportProvider value={activeHost?.id ?? null}>
              {connected && hostRestored ? (
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/services" element={<Services />} />
                  <Route path="/containers" element={<Containers />} />
                  <Route path="/logs" element={<Logs />} />
                  <Route path="/terminal" element={<Terminal user={user} />} />
                  <Route path="/storage" element={<Storage />} />
                  <Route path="/networking" element={<Networking />} />
                  <Route path="/packages" element={<Packages />} />
                  <Route path="/users" element={<Users />} />
                  <Route path="/files" element={<Files user={user} />} />
                  <Route path="/kdump" element={<Kdump />} />
                  <Route path="/log-files" element={<LogFiles />} />
                </Routes>
              ) : (
                <p>Connecting to server...</p>
              )}
            </HostTransportProvider>
          </main>
        </div>

        {/* ── Host Management Modal ── */}
        {hostManageOpen && (
          <div style={S.modalOverlay} onClick={() => setHostManageOpen(false)}>
            <div style={{ ...S.modal, maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
              <Hosts onClose={() => { setHostManageOpen(false); loadHosts(); }} onChange={loadHosts} />
            </div>
          </div>
        )}
      </div>
    </SuperuserContext.Provider>
  );
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  },

  /* ── top bar ── */
  topBar: {
    height: TOP_BAR_H,
    minHeight: TOP_BAR_H,
    background: '#0d1117',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 1rem',
    zIndex: 100,
  },
  topLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  hostIcon: { fontSize: '0.9rem' },
  hostName: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  topRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  topBtn: {
    padding: '0.25rem 0.65rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.78rem',
    whiteSpace: 'nowrap' as const,
  },

  /* ── dropdowns ── */
  dropdownWrap: { position: 'relative' as const },
  dropdown: {
    position: 'absolute' as const,
    top: 'calc(100% + 6px)',
    right: 0,
    background: '#1a1b26',
    border: '1px solid #292e42',
    borderRadius: 8,
    padding: '0.6rem 0',
    minWidth: 220,
    zIndex: 200,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  dropdownTitle: {
    padding: '0.3rem 0.9rem 0.5rem',
    fontSize: '0.8rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
    borderBottom: '1px solid #292e42',
    marginBottom: '0.3rem',
  },
  dropdownItem: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.3rem 0.9rem',
    fontSize: '0.78rem',
    color: 'var(--text-primary)',
  },
  dropdownLabel: {
    color: 'var(--text-secondary)',
  },
  dropdownHr: {
    border: 'none',
    borderTop: '1px solid #292e42',
    margin: '0.4rem 0',
  },
  dropdownLink: {
    display: 'block',
    padding: '0.3rem 0.9rem',
    fontSize: '0.78rem',
    color: 'var(--accent)',
    textDecoration: 'none',
  },
  dropdownLogout: {
    width: '100%',
    padding: '0.4rem 0.9rem',
    border: 'none',
    background: 'transparent',
    color: '#f7768e',
    fontSize: '0.8rem',
    fontWeight: 600,
    textAlign: 'left' as const,
    cursor: 'pointer',
  },

  /* ── body (sidebar + main) ── */
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '220px',
    minWidth: '220px',
    background: 'var(--bg-secondary)',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid var(--border)',
    overflowY: 'auto' as const,
  },
  logo: {
    fontSize: '1.25rem',
    fontWeight: 700,
    marginBottom: '0.5rem',
    color: 'var(--accent)',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
  },
  sidebarLogo: {
    width: '32px',
    height: '32px',
    objectFit: 'contain' as const,
  },
  status: {
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
    marginBottom: '0.75rem',
  },
  navList: {
    listStyle: 'none',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
  },
  sectionDivider: {
    height: '1px',
    background: '#414868',
    marginTop: '0.75rem',
    marginBottom: '0.5rem',
  },
  sectionLabel: {
    fontSize: '0.7rem',
    fontWeight: 700,
    color: '#a9b1d6',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    padding: '0 0.75rem',
    marginBottom: '0.35rem',
  },
  sectionList: {
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.15rem',
  },
  navLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.75rem',
    borderRadius: '4px',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    fontSize: '0.9rem',
  },
  navIcon: {
    fontSize: '1rem',
    width: '1.4rem',
    textAlign: 'center' as const,
  },
  main: {
    flex: 1,
    padding: '1.5rem',
    overflow: 'auto',
  },

  /* ── modal ── */
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 500,
  },
  modal: {
    background: '#1a1b26',
    border: '1px solid #292e42',
    borderRadius: 10,
    padding: '1.5rem',
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: '1rem',
    fontWeight: 700,
    marginBottom: '0.5rem',
  },
  modalDesc: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    marginBottom: '1rem',
    lineHeight: 1.5,
  },
  modalError: {
    color: '#f7768e',
    fontSize: '0.82rem',
    marginBottom: '0.5rem',
  },
  modalInput: {
    width: '100%',
    padding: '0.6rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.9rem',
    marginBottom: '1rem',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
  },
  modalCancelBtn: {
    padding: '0.4rem 0.9rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.82rem',
  },
  modalSubmitBtn: {
    padding: '0.4rem 0.9rem',
    borderRadius: 4,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.82rem',
  },

  /* ── host selector ── */
  hostSelector: {
    position: 'relative' as const,
    marginBottom: '0.75rem',
  },
  hostSelectorBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.45rem 0.6rem',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  hostDropdown: {
    position: 'absolute' as const,
    top: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    background: '#1a1b26',
    border: '1px solid #292e42',
    borderRadius: 8,
    padding: '0.3rem 0',
    zIndex: 300,
    maxHeight: 320,
    overflowY: 'auto' as const,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  },
  hostOption: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.45rem 0.6rem',
    cursor: 'pointer',
    fontSize: '0.82rem',
    color: 'var(--text-primary)',
  },
  hostOptionName: {
    fontWeight: 600,
    fontSize: '0.82rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  hostOptionAddr: {
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  hostDropdownDivider: {
    height: 1,
    background: '#292e42',
    margin: '0.25rem 0',
  },
};
