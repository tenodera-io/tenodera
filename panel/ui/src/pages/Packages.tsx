import { useEffect, useState, useRef, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from './Shell.tsx';
import type { Message } from '../api/transport.ts';

/* ── types ─────────────────────────────────────────────── */

interface PkgInfo {
  name: string;
  version: string;
  repo?: string;
  installed?: boolean;
  description?: string;
}

interface UpdateInfo {
  name: string;
  current: string;
  available: string;
}

interface RepoInfo {
  name: string;
  enabled: boolean;
  // pacman fields
  server?: string;
  include?: string;
  sig_level?: string;
  // apt fields
  line?: string;
  file?: string;
  format?: string;
  // apt deb822 fields
  Types?: string;
  URIs?: string;
  Suites?: string;
  Components?: string;
  // dnf fields
  description?: string;
}

/* ── constants ─────────────────────────────────────────── */

type Tab = 'installed' | 'search' | 'updates' | 'repos';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'installed', label: 'Installed', icon: '📦' },
  { id: 'search', label: 'Search', icon: '🔍' },
  { id: 'updates', label: 'Updates', icon: '⬆️' },
  { id: 'repos', label: 'Repositories', icon: '🗄️' },
];

/* ── component ─────────────────────────────────────────── */

export function Packages() {
  const { openChannel } = useTransport();
  const su = useSuperuser();
  const [tab, setTab] = useState<Tab>(() => {
    const saved = sessionStorage.getItem('pkg_tab');
    return (saved === 'search' || saved === 'updates' || saved === 'repos') ? saved : 'installed';
  });
  const changeTab = (t: Tab) => { setTab(t); sessionStorage.setItem('pkg_tab', t); };
  const [backend, setBackend] = useState('');
  const [distroName, setDistroName] = useState('');
  const [loading, setLoading] = useState(false);

  // Installed
  const [installed, setInstalled] = useState<PkgInfo[]>([]);
  const [installedCount, setInstalledCount] = useState(0);
  const [installedFilter, setInstalledFilter] = useState('');

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PkgInfo[]>([]);

  // Updates
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [updateCount, setUpdateCount] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState('');

  // Repos
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [newRepoName, setNewRepoName] = useState('');

  // Actions
  const [actionMsg, setActionMsg] = useState('');
  const [actionError, setActionError] = useState('');

  // Password prompt
  const [pwPrompt, setPwPrompt] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  /* ── manage channel ────────────────────────────────────── */
  const manageRef = useRef<ReturnType<typeof openChannel> | null>(null);

  const getManageChannel = useCallback(() => {
    if (!manageRef.current) {
      const ch = openChannel('packages.manage');
      manageRef.current = ch;
    }
    return manageRef.current;
  }, []);

  const sendManage = useCallback((data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    return new Promise((resolve) => {
      const ch = getManageChannel();
      const sentAction = data.action as string | undefined;
      let resolved = false;
      const handler = (msg: Message) => {
        if (resolved) return;
        if (msg.type === 'data' && 'data' in msg) {
          const res = msg.data as Record<string, unknown>;
          // If we sent an action and the response has an action field, only resolve
          // if they match — prevents cross-talk between concurrent requests
          if (sentAction && typeof res.action === 'string' && res.action !== sentAction) {
            return;
          }
          resolved = true;
          resolve(res);
        }
      };
      ch.onMessage(handler);
      ch.send(data);
    });
  }, [getManageChannel]);

  const getPassword = useCallback((): Promise<string> => {
    if (su.active && su.password) return Promise.resolve(su.password);
    return new Promise((resolve) => {
      setPwPrompt(true);
      setPwInput('');
      setPendingAction(() => () => {
        const el = document.getElementById('pkg-pw-input') as HTMLInputElement;
        const pw = el?.value || '';
        setPwPrompt(false);
        resolve(pw);
      });
    });
  }, [su]);

  const sudoAction = useCallback(async (actionData: Record<string, unknown>) => {
    const pw = await getPassword();
    return sendManage({ ...actionData, password: pw });
  }, [getPassword, sendManage]);

  /* ── cleanup ──────────────────────────────────────────── */
  useEffect(() => {
    return () => { manageRef.current?.close(); };
  }, []);

  /* ── detect backend on mount ──────────────────────────── */
  useEffect(() => {
    (async () => {
      const res = await sendManage({ action: 'detect' });
      setBackend((res.backend as string) || '');
      setDistroName((res.distro_name as string) || '');
    })();
  }, [sendManage]);

  /* ── load installed ───────────────────────────────────── */
  const loadInstalled = useCallback(async () => {
    setLoading(true);
    const res = await sendManage({ action: 'list_installed' });
    setInstalled((res.packages as PkgInfo[]) || []);
    setInstalledCount((res.count as number) || 0);
    setLoading(false);
  }, [sendManage]);

  useEffect(() => {
    if (tab === 'installed' && installed.length === 0) loadInstalled();
  }, [tab, installed.length, loadInstalled]);

  /* ── search ───────────────────────────────────────────── */
  const doSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setSearchResults([]);
    const res = await sendManage({ action: 'search', query: searchQuery.trim() });
    setSearchResults((res.packages as PkgInfo[]) || []);
    setLoading(false);
  }, [searchQuery, sendManage]);

  /* ── check updates ────────────────────────────────────── */
  const loadUpdates = useCallback(async () => {
    setLoading(true);
    const res = await sendManage({ action: 'check_updates' });
    setUpdates((res.updates as UpdateInfo[]) || []);
    setUpdateCount((res.count as number) || 0);
    setLoading(false);
  }, [sendManage]);

  useEffect(() => {
    if (tab === 'updates' && updates.length === 0 && updateCount === 0) loadUpdates();
  }, [tab, updates.length, updateCount, loadUpdates]);

  /* ── load repos ───────────────────────────────────────── */
  const loadRepos = useCallback(async () => {
    setLoading(true);
    const res = await sendManage({ action: 'list_repos' });
    setRepos((res.repos as RepoInfo[]) || []);
    setLoading(false);
  }, [sendManage]);

  useEffect(() => {
    if (tab === 'repos' && repos.length === 0) loadRepos();
  }, [tab, repos.length, loadRepos]);

  /* ── actions ──────────────────────────────────────────── */
  const installPkg = async (name: string) => {
    setActionMsg(''); setActionError('');
    const res = await sudoAction({ action: 'install', names: [name] });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`Installed ${name}`); loadInstalled(); }
  };

  const removePkg = async (name: string) => {
    setActionMsg(''); setActionError('');
    const res = await sudoAction({ action: 'remove', names: [name] });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`Removed ${name}`); loadInstalled(); }
  };

  const updateSystem = async () => {
    setUpdating(true); setUpdateOutput(''); setActionError('');
    const res = await sudoAction({ action: 'update_system' });
    if (res.error) { setActionError(String(res.error)); }
    else { setUpdateOutput(String(res.output || 'System updated successfully')); loadUpdates(); }
    setUpdating(false);
  };

  const refreshRepos = async () => {
    setActionMsg(''); setActionError('');
    const res = await sudoAction({ action: 'refresh_repos' });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg('Repositories refreshed'); loadRepos(); }
  };

  const addRepo = async () => {
    if (!newRepoUrl.trim()) return;
    setActionMsg(''); setActionError('');
    const res = await sudoAction({ action: 'add_repo', repo: newRepoUrl.trim(), name: newRepoName.trim() });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg('Repository added'); setNewRepoUrl(''); setNewRepoName(''); loadRepos(); }
  };

  const removeRepo = async (repo: string) => {
    setActionMsg(''); setActionError('');
    const res = await sudoAction({ action: 'remove_repo', repo });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg('Repository removed'); loadRepos(); }
  };

  /* ── filtered installed list ──────────────────────────── */
  const filteredInstalled = installedFilter
    ? installed.filter(p => p.name.toLowerCase().includes(installedFilter.toLowerCase()))
    : installed;

  /* ── render ───────────────────────────────────────────── */
  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <h2 style={S.title}>📦 Packages</h2>
        <div style={S.headerInfo}>
          <span style={S.badge}>{backend}</span>
          {distroName && <span style={S.distro}>{distroName}</span>}
        </div>
      </div>

      {/* Messages */}
      {actionMsg && <div style={S.successMsg}>{actionMsg}</div>}
      {actionError && <div style={S.errorMsg}>{actionError}</div>}

      {/* Tabs */}
      <div style={S.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => changeTab(t.id)}
            style={tab === t.id ? { ...S.tab, ...S.tabActive } : S.tab}
          >
            {t.icon} {t.label}
            {t.id === 'updates' && updateCount > 0 && (
              <span style={S.updateBadge}>{updateCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={S.content}>
        {/* ── Installed tab ── */}
        {tab === 'installed' && (
          <div>
            <div style={S.toolbar}>
              <input
                type="text"
                placeholder="Filter installed packages..."
                value={installedFilter}
                onChange={e => setInstalledFilter(e.target.value)}
                style={{ ...S.input, borderColor: installedFilter ? '#7aa2f7' : '#9ece6a' }}
              />
              <button onClick={loadInstalled} style={S.btn} disabled={loading}>
                {loading ? '⏳' : '🔄'} Refresh
              </button>
              <span style={S.count}>{filteredInstalled.length} / {installedCount} packages</span>
            </div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Name</th>
                    <th style={S.th}>Version</th>
                    <th style={{ ...S.th, width: 100 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInstalled.slice(0, 500).map(p => (
                    <tr key={p.name} style={S.tr}>
                      <td style={S.td}>{p.name}</td>
                      <td style={S.tdMono}>{p.version}</td>
                      <td style={S.td}>
                        <button onClick={() => removePkg(p.name)} style={S.btnDanger} title="Remove">
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredInstalled.length > 500 && (
                <p style={S.muted}>Showing first 500 of {filteredInstalled.length}. Use filter to narrow down.</p>
              )}
            </div>
          </div>
        )}

        {/* ── Search tab ── */}
        {tab === 'search' && (
          <div>
            <div style={S.toolbar}>
              <input
                type="text"
                placeholder="Search packages..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
                style={{ ...S.input, flex: 1, borderColor: searchQuery ? '#7aa2f7' : '#9ece6a' }}
              />
              <button onClick={doSearch} style={S.btn} disabled={loading || !searchQuery.trim()}>
                {loading ? '⏳' : '🔍'} Search
              </button>
            </div>
            {searchResults.length > 0 && (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Name</th>
                      <th style={S.th}>Version</th>
                      {backend === 'pacman' && <th style={S.th}>Repo</th>}
                      <th style={S.th}>Description</th>
                      <th style={{ ...S.th, width: 100 }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map(p => (
                      <tr key={p.name + (p.repo || '')} style={S.tr}>
                        <td style={S.td}>
                          {p.name}
                          {p.installed && <span style={S.installedBadge}>installed</span>}
                        </td>
                        <td style={S.tdMono}>{p.version}</td>
                        {backend === 'pacman' && <td style={S.td}>{p.repo}</td>}
                        <td style={{ ...S.td, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                          {p.description}
                        </td>
                        <td style={S.td}>
                          {p.installed ? (
                            <button onClick={() => removePkg(p.name)} style={S.btnDanger} title="Remove">🗑️</button>
                          ) : (
                            <button onClick={() => installPkg(p.name)} style={S.btnSuccess} title="Install">📥</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {loading && <div style={S.loadingText}>Searching...</div>}
          </div>
        )}

        {/* ── Updates tab ── */}
        {tab === 'updates' && (
          <div>
            <div style={S.toolbar}>
              <button onClick={loadUpdates} style={S.btn} disabled={loading}>
                {loading ? '⏳' : '🔄'} Check Updates
              </button>
              {updates.length > 0 && (
                <button onClick={updateSystem} style={S.btnSuccess} disabled={updating}>
                  {updating ? '⏳ Updating...' : '⬆️ Update System'}
                </button>
              )}
              <span style={S.count}>{updateCount} update{updateCount !== 1 ? 's' : ''} available</span>
            </div>
            {updates.length > 0 && (
              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={S.th}>Package</th>
                      <th style={S.th}>Current</th>
                      <th style={S.th}>Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {updates.map(u => (
                      <tr key={u.name} style={S.tr}>
                        <td style={S.td}>{u.name}</td>
                        <td style={S.tdMono}>{u.current || '—'}</td>
                        <td style={{ ...S.tdMono, color: '#9ece6a' }}>{u.available}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {updates.length === 0 && !loading && (
              <div style={S.emptyState}>✅ System is up to date</div>
            )}
            {updateOutput && (
              <pre style={S.outputPre}>{updateOutput}</pre>
            )}
          </div>
        )}

        {/* ── Repos tab ── */}
        {tab === 'repos' && (
          <div>
            <div style={S.toolbar}>
              <button onClick={loadRepos} style={S.btn} disabled={loading}>
                {loading ? '⏳' : '🔄'} Refresh List
              </button>
              <button onClick={refreshRepos} style={S.btn}>
                📡 Sync Repositories
              </button>
            </div>

            {/* Add repo form */}
            <div style={S.formCard}>
              <h4 style={S.formTitle}>Add Repository</h4>
              <div style={S.formRow}>
                {backend === 'pacman' && (
                  <input
                    type="text"
                    placeholder="Repository name"
                    value={newRepoName}
                    onChange={e => setNewRepoName(e.target.value)}
                    style={{ ...S.input, width: 200, borderColor: newRepoName ? '#7aa2f7' : '#9ece6a' }}
                  />
                )}
                <input
                  type="text"
                  placeholder={
                    backend === 'pacman' ? 'Server URL (e.g. https://mirror.example.com/$repo/os/$arch)' :
                    backend === 'apt' ? 'deb http://... or ppa:user/name' :
                    'Repository URL'
                  }
                  value={newRepoUrl}
                  onChange={e => setNewRepoUrl(e.target.value)}
                  style={{ ...S.input, flex: 1, borderColor: newRepoUrl ? '#7aa2f7' : '#9ece6a' }}
                />
                <button onClick={addRepo} style={S.btnSuccess} disabled={!newRepoUrl.trim()}>
                  ➕ Add
                </button>
              </div>
            </div>

            {/* Repos list */}
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Name</th>
                    {backend === 'pacman' && <th style={S.th}>Server / Include</th>}
                    {backend === 'apt' && <th style={S.th}>Source</th>}
                    {backend === 'dnf' && <th style={S.th}>Description</th>}
                    <th style={S.th}>Status</th>
                    <th style={{ ...S.th, width: 80 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {repos.map((r, i) => (
                    <tr key={r.name + i} style={S.tr}>
                      <td style={S.td}>{r.name}</td>
                      {backend === 'pacman' && (
                        <td style={{ ...S.td, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                          {r.server || r.include || '—'}
                        </td>
                      )}
                      {backend === 'apt' && (
                        <td style={{ ...S.td, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                          {r.format === 'deb822'
                            ? `${r.Types || ''} ${r.URIs || ''} ${r.Suites || ''} ${r.Components || ''}`
                            : r.line || '—'}
                        </td>
                      )}
                      {backend === 'dnf' && (
                        <td style={S.td}>{r.description || '—'}</td>
                      )}
                      <td style={S.td}>
                        <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e' }}>
                          {r.enabled ? '● Enabled' : '○ Disabled'}
                        </span>
                      </td>
                      <td style={S.td}>
                        <button
                          onClick={() => removeRepo(
                            backend === 'apt' && r.file ? r.file : r.name
                          )}
                          style={S.btnDanger}
                          title="Remove"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {loading && tab !== 'search' && <div style={S.loadingText}>Loading...</div>}
      </div>

      {/* Password modal */}
      {pwPrompt && (
        <div style={S.overlay}>
          <form style={S.modal} onSubmit={e => { e.preventDefault(); pendingAction?.(); }}>
            <h3 style={S.modalTitle}>🔑 Authentication Required</h3>
            <p style={S.modalText}>Enter password to perform this action.</p>
            <input
              id="pkg-pw-input"
              type="password"
              placeholder="Password"
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              style={{ ...S.modalInput, borderColor: pwInput ? '#7aa2f7' : '#9ece6a' }}
              autoFocus
              autoComplete="current-password"
            />
            <div style={S.modalActions}>
              <button type="button" onClick={() => setPwPrompt(false)} style={S.btnCancel}>Cancel</button>
              <button type="submit" style={S.btnSuccess}>Authenticate</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  page: {
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    height: '100%',
    overflow: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap',
  },
  title: {
    margin: 0,
    fontSize: '1.4rem',
    color: 'var(--text-primary)',
  },
  headerInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  badge: {
    background: '#7aa2f7',
    color: '#1a1b26',
    padding: '2px 10px',
    borderRadius: 12,
    fontSize: '0.8rem',
    fontWeight: 600,
  },
  distro: {
    color: 'var(--text-secondary)',
    fontSize: '0.9rem',
  },
  successMsg: {
    background: 'rgba(158,206,106,0.15)',
    color: '#9ece6a',
    padding: '0.5rem 1rem',
    borderRadius: 8,
    fontSize: '0.85rem',
  },
  errorMsg: {
    background: 'rgba(247,118,142,0.15)',
    color: '#f7768e',
    padding: '0.5rem 1rem',
    borderRadius: 8,
    fontSize: '0.85rem',
  },
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    borderBottom: '1px solid var(--border)',
    paddingBottom: 0,
  },
  tab: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
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
    color: 'var(--accent)',
    borderBottom: '2px solid var(--accent)',
  },
  updateBadge: {
    background: '#f7768e',
    color: '#fff',
    borderRadius: 10,
    padding: '0 6px',
    fontSize: '0.7rem',
    fontWeight: 700,
    marginLeft: 4,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
    flexWrap: 'wrap',
  },
  input: {
    background: 'var(--bg-card)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: '0.85rem',
    outline: 'none',
    minWidth: 200,
  },
  btn: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap',
  },
  btnSuccess: {
    background: 'rgba(158,206,106,0.2)',
    border: '1px solid #9ece6a',
    color: '#9ece6a',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap',
  },
  btnDanger: {
    background: 'rgba(247,118,142,0.15)',
    border: '1px solid #f7768e',
    color: '#f7768e',
    padding: '4px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  btnCancel: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  count: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    marginLeft: 'auto',
  },
  tableWrap: {
    overflowX: 'auto',
    maxHeight: 'calc(100vh - 320px)',
    overflowY: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.85rem',
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontWeight: 600,
    position: 'sticky',
    top: 0,
    background: 'var(--bg-base)',
    zIndex: 1,
  },
  tr: {
    borderBottom: '1px solid rgba(65,72,104,0.3)',
  },
  td: {
    padding: '6px 12px',
    color: 'var(--text-primary)',
  },
  tdMono: {
    padding: '6px 12px',
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    fontSize: '0.8rem',
  },
  installedBadge: {
    background: 'rgba(158,206,106,0.2)',
    color: '#9ece6a',
    fontSize: '0.7rem',
    padding: '1px 6px',
    borderRadius: 8,
    marginLeft: 8,
  },
  loadingText: {
    color: 'var(--text-secondary)',
    textAlign: 'center',
    padding: '2rem',
  },
  emptyState: {
    color: 'var(--text-secondary)',
    textAlign: 'center',
    padding: '3rem',
    fontSize: '1.1rem',
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    padding: '0.5rem 0',
  },
  outputPre: {
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    padding: '1rem',
    borderRadius: 8,
    fontSize: '0.8rem',
    maxHeight: 300,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    marginTop: '0.75rem',
  },
  formCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1rem',
    marginBottom: '1rem',
  },
  formTitle: {
    margin: '0 0 0.5rem 0',
    color: 'var(--text-primary)',
    fontSize: '0.95rem',
  },
  formRow: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  overlay: {
    position: 'fixed',
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '1.5rem',
    minWidth: 340,
  },
  modalTitle: {
    margin: '0 0 0.5rem 0',
    color: 'var(--text-primary)',
  },
  modalText: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    margin: '0 0 1rem 0',
  },
  modalInput: {
    width: '100%',
    background: 'var(--bg-base)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: '0.9rem',
    marginBottom: '1rem',
    outline: 'none',
    boxSizing: 'border-box',
  },
  modalActions: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'flex-end',
  },
};
