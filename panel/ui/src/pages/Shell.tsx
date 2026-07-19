import { useEffect, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { connect, disconnect, onConnectionChange, request, type ConnectionState } from '../api/transport.ts';
import { HostTransportProvider } from '../api/HostTransportContext.tsx';
import { SuperuserContext } from '../api/SuperuserContext.tsx';
import { RoleContext } from '../contexts/RoleContext.ts';
import { ToastProvider } from '../contexts/ToastContext.tsx';
import { ThemeProvider } from '../contexts/ThemeContext.tsx';
import { useHosts } from '../hooks/useHosts.ts';
import { preferredLocalIp, type IfaceLike } from '../api/primaryIp.ts';
import { useSuperuser } from '../hooks/useSuperuser.ts';
import { TopBar } from '../components/TopBar.tsx';
import { Sidebar } from '../components/Sidebar.tsx';
import { SuperuserModal } from '../components/SuperuserModal.tsx';
import { CommandPalette } from '../components/CommandPalette.tsx';
import { ErrorBoundary } from '../components/ErrorBoundary.tsx';
import { Hosts } from './Hosts.tsx';
import type { UserRole } from '../api/auth.ts';

const Dashboard   = lazy(() => import('./Dashboard.tsx').then(m => ({ default: m.Dashboard })));
const Services    = lazy(() => import('./Services.tsx').then(m => ({ default: m.Services })));
const Logs        = lazy(() => import('./Logs.tsx').then(m => ({ default: m.Logs })));
const Terminal    = lazy(() => import('./Terminal.tsx').then(m => ({ default: m.Terminal })));
const Files       = lazy(() => import('./Files.tsx').then(m => ({ default: m.Files })));
const Containers  = lazy(() => import('./Containers.tsx').then(m => ({ default: m.Containers })));
const Storage     = lazy(() => import('./Storage.tsx').then(m => ({ default: m.Storage })));
const Networking  = lazy(() => import('./Networking.tsx').then(m => ({ default: m.Networking })));
const Packages    = lazy(() => import('./Packages.tsx').then(m => ({ default: m.Packages })));
const Kdump       = lazy(() => import('./Kdump.tsx').then(m => ({ default: m.Kdump })));
const System      = lazy(() => import('./System.tsx').then(m => ({ default: m.System })));
const LogFiles    = lazy(() => import('./LogFiles.tsx').then(m => ({ default: m.LogFiles })));
const Users       = lazy(() => import('./Users.tsx').then(m => ({ default: m.Users })));
const Cron        = lazy(() => import('./Cron.tsx').then(m => ({ default: m.Cron })));
const DNS          = lazy(() => import('./DNS.tsx').then(m => ({ default: m.DNS })));
const Certificates = lazy(() => import('./Certificates.tsx').then(m => ({ default: m.Certificates })));
const Management   = lazy(() => import('./Management.tsx').then(m => ({ default: m.Management })));
const ApiDocs      = lazy(() => import('./ApiDocs.tsx').then(m => ({ default: m.ApiDocs })));
const Audit        = lazy(() => import('./Audit.tsx').then(m => ({ default: m.Audit })));
const Ssh          = lazy(() => import('./Ssh.tsx').then(m => ({ default: m.Ssh })));
const Security     = lazy(() => import('./Security.tsx').then(m => ({ default: m.Security })));

interface ShellProps {
  sessionId: string;
  user: string;
  role: UserRole;
  onLogout: () => void;
}

export function Shell({ user, role, onLogout }: ShellProps) {
  const [connected, setConnected] = useState(false);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [hostname, setHostname] = useState('');
  const [localIp, setLocalIp] = useState<string>(() => preferredLocalIp());
  const [hostManageOpen, setHostManageOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  const { hosts, activeHost, hostStatuses, remoteStatus, userExistsMap, loadHosts, switchHost } = useHosts(connected);
  const su = useSuperuser(activeHost?.id);

  const fetchLocalInfo = useCallback(() => {
    request('system.info').then((results) => {
      const info = results[0] as { hostname?: string } | undefined;
      if (info?.hostname) setHostname(info.hostname);
    }).catch(() => { /* best-effort */ });
    request('network.stats').then((results) => {
      const data = results[0] as { interfaces?: IfaceLike[] } | undefined;
      setLocalIp(preferredLocalIp(data?.interfaces));
    }).catch(() => { /* best-effort */ });
    loadHosts();
  }, [loadHosts]);

  useEffect(() => {
    const unsub = onConnectionChange((state) => {
      setConnState(state);
      setConnected(state === 'connected');
      if (state === 'connected') fetchLocalInfo();
    });

    connect()
      .then(() => { setConnState('connected'); setConnected(true); fetchLocalInfo(); })
      .catch(() => { setConnState('disconnected'); setConnected(false); });

    return () => { unsub(); disconnect(); };
  }, [fetchLocalInfo]);

  const handleLogout = () => {
    const sessionId = sessionStorage.getItem('session_id') ?? '';
    if (sessionId) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionId}` },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => { /* best-effort */ });
    }
    disconnect();
    sessionStorage.removeItem('session_id');
    sessionStorage.removeItem('su_active');
    sessionStorage.removeItem('active_host_id');
    su.clearSuperuser();
    onLogout();
    navigate('/login');
  };

  // Global Ctrl/Cmd+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const suCtx = useMemo(() => ({ active: su.suActive, password: su.suPassword }), [su.suActive, su.suPassword]);

  return (
    <ThemeProvider username={user}>
    <RoleContext.Provider value={role}>
    <SuperuserContext.Provider value={suCtx}>
    <ToastProvider>
      <div className="app-shell">
        <TopBar
          hostname={hostname}
          activeHost={activeHost}
          remoteStatus={remoteStatus}
          connState={connState}
          suActive={su.suActive}
          user={user}
          localIp={localIp}
          onSuperuserClick={su.handleSuperuserClick}
          onLogout={handleLogout}
          onToggleNav={() => setNavOpen((v) => !v)}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        {activeHost && userExistsMap[activeHost.id] === false && (
          <div style={{
            padding: '0.4rem 1rem',
            background: 'color-mix(in srgb, var(--c-yellow) 12%, var(--bg-surface))',
            borderBottom: '1px solid color-mix(in srgb, var(--c-yellow) 30%, transparent)',
            color: 'color-mix(in srgb, var(--c-yellow) 80%, var(--text-1))',
            fontSize: '0.78rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 11.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm.75-3.5a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0v4z"/>
            </svg>
            Account <strong style={{ fontWeight: 600 }}>{user}</strong> does not exist on this host.
          </div>
        )}

        {su.suPrompt && (
          <SuperuserModal
            suPwInput={su.suPwInput}
            suError={su.suError}
            onPwChange={su.setSuPwInput}
            onSubmit={su.handleSuperuserSubmit}
            onClose={su.closeSuPrompt}
          />
        )}

        <CommandPalette
          open={paletteOpen && !!activeHost}
          onClose={() => setPaletteOpen(false)}
          suActive={su.suActive}
        />

        <div className="app-body">
          <div
            className={`sidebar-backdrop${navOpen ? ' show' : ''}`}
            onClick={() => setNavOpen(false)}
          />
          <Sidebar
            hosts={hosts}
            activeHost={activeHost}
            hostStatuses={hostStatuses}
            connState={connState}
            open={navOpen}
            onSwitchHost={switchHost}
            onOpenManageHosts={() => setHostManageOpen(true)}
            onClose={() => setNavOpen(false)}
          />
          <main className="app-main page-fade-in">
            <HostTransportProvider value={activeHost?.id ?? null}>
              {connected && !activeHost ? (
                <div style={S.offlineOverlay}>
                  <div style={S.offlineBox}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🌐</div>
                    <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>Select a host to get started</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-2)' }}>
                      Choose a host from the sidebar. Use <b>Manage hosts…</b> to add new machines.
                    </div>
                  </div>
                </div>
              ) : connected ? (
                <ErrorBoundary>
                  <Suspense fallback={<div style={S.lazyFallback}>Loading...</div>}>
                    <Routes>
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/services" element={<Services />} />
                      <Route path="/containers" element={<Containers />} />
                      <Route path="/logs" element={<Logs />} />
                      <Route path="/terminal" element={su.suActive ? <Terminal user={user} hostname={activeHost ? activeHost.name : hostname} /> : <Navigate to="/" />} />
                      <Route path="/storage" element={<Storage />} />
                      <Route path="/networking" element={<Networking />} />
                      <Route path="/packages" element={<Packages />} />
                      <Route path="/users" element={<Users />} />
                      <Route path="/cron" element={<Cron />} />
                      <Route path="/dns" element={<DNS />} />
                      <Route path="/certificates" element={<Certificates />} />
                      <Route path="/management" element={<Management hosts={hosts} activeHost={activeHost} onSwitchHost={switchHost} onReloadHosts={loadHosts} userExistsMap={userExistsMap} />} />
                      <Route path="/api-docs" element={su.suActive ? <ApiDocs /> : <Navigate to="/" />} />
                      <Route path="/audit" element={su.suActive ? <Audit /> : <Navigate to="/" />} />
                      <Route path="/ssh" element={su.suActive ? <Ssh loginUser={user} /> : <Navigate to="/" />} />
                      <Route path="/security" element={su.suActive ? <Security /> : <Navigate to="/" />} />
                      <Route path="/files" element={<Files user={user} />} />
                      <Route path="/kdump" element={<Kdump />} />
                      <Route path="/system" element={<System />} />
                      <Route path="/log-files" element={<LogFiles />} />
                    </Routes>
                  </Suspense>
                </ErrorBoundary>
              ) : (
                <div style={S.offlineOverlay}>
                  <div style={S.offlineBox}>
                    <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>
                      {connState === 'reconnecting' ? '◌' : '○'}
                    </div>
                    <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                      {connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting to server…'}
                    </div>
                    {connState === 'reconnecting' && (
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-2)' }}>
                        Connection lost. Retrying automatically.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </HostTransportProvider>
          </main>
        </div>

        {hostManageOpen && (
          <div style={S.modalOverlay} onClick={() => setHostManageOpen(false)}>
            <div style={{ ...S.modal, maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
              <Hosts onClose={() => { setHostManageOpen(false); loadHosts(); }} onChange={loadHosts} />
            </div>
          </div>
        )}
      </div>
    </ToastProvider>
    </SuperuserContext.Provider>
    </RoleContext.Provider>
    </ThemeProvider>
  );
}

const S: Record<string, React.CSSProperties> = {
  lazyFallback: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-2)', fontSize: '0.9rem' },
  offlineOverlay: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, height: '100%' },
  offlineBox: { textAlign: 'center', color: 'var(--text-2)', fontSize: '0.9rem' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500 },
  modal: { background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 10, padding: '1.5rem', width: '100%' },
};

import React from 'react';
