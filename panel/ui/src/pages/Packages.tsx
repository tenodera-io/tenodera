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
  const changeTab = (t: Tab) => { if (updating) return; setTab(t); sessionStorage.setItem('pkg_tab', t); };
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
  const [busyPkg, setBusyPkg] = useState<{ name: string; op: 'install' | 'remove' } | null>(null);

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
  }, [openChannel]);

  const sendManage = useCallback((data: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const ch = getManageChannel();
      const sentAction = data.action as string | undefined;
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        removeHandler();
        reject(new Error('request timed out'));
      }, timeoutMs);
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
          clearTimeout(timer);
          removeHandler();
          resolve(res);
        }
      };
      const removeHandler = ch.onMessage(handler);
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

  const sudoAction = useCallback(async (actionData: Record<string, unknown>, timeoutMs = 600_000) => {
    const pw = await getPassword();
    return sendManage({ ...actionData, password: pw }, timeoutMs);
  }, [getPassword, sendManage]);

  /* ── cleanup / host change ─────────────────────────────── */
  useEffect(() => {
    // Reset state when host changes (openChannel identity changes)
    setBackend('');
    setDistroName('');
    setInstalled([]);
    setInstalledCount(0);
    setSearchResults([]);
    setUpdates([]);
    setUpdateCount(0);
    setRepos([]);
    setActionMsg('');
    setActionError('');
    setBusyPkg(null);

    // Close stale manage channel from previous host
    manageRef.current?.close();
    manageRef.current = null;

    return () => { manageRef.current?.close(); };
  }, [openChannel]);

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
    setBusyPkg({ name, op: 'install' });
    const res = await sudoAction({ action: 'install', names: [name] });
    setBusyPkg(null);
    if (res.error) setActionError(String(res.error));
    else {
      setActionMsg(`Installed ${name}`);
      loadInstalled();
      // Mark as installed in search results without re-searching
      setSearchResults(prev => prev.map(p => p.name === name ? { ...p, installed: true } : p));
    }
  };

  const removePkg = async (name: string) => {
    setActionMsg(''); setActionError('');
    setBusyPkg({ name, op: 'remove' });
    const res = await sudoAction({ action: 'remove', names: [name] });
    setBusyPkg(null);
    if (res.error) setActionError(String(res.error));
    else {
      setActionMsg(`Removed ${name}`);
      loadInstalled();
      // Mark as uninstalled in search results without re-searching
      setSearchResults(prev => prev.map(p => p.name === name ? { ...p, installed: false } : p));
    }
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

  /* ── block navigation while updating ─────────────────── */
  useEffect(() => {
    if (!updating) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [updating]);

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
            style={tab === t.id ? { ...S.tab, ...S.tabActive } : updating ? { ...S.tab, opacity: 0.5, cursor: 'not-allowed' } : S.tab}
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
                        <button
                          onClick={() => removePkg(p.name)}
                          style={S.btnDanger}
                          title="Remove"
                          disabled={busyPkg !== null}
                        >
                          {busyPkg?.name === p.name ? '...' : '🗑️'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {busyPkg && (
                <div style={S.progressWrap}>
                  <span style={S.progressLabel}>
                    {busyPkg.op === 'install' ? '📥 Installing' : '🗑️ Removing'} {busyPkg.name}...
                  </span>
                  <div style={S.progressTrack}>
                    <div style={S.progressBar} />
                  </div>
                </div>
              )}
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
                            <button
                              onClick={() => removePkg(p.name)}
                              style={S.btnDanger}
                              title="Remove"
                              disabled={busyPkg !== null}
                            >
                              {busyPkg?.name === p.name ? '...' : '🗑️'}
                            </button>
                          ) : (
                            <button
                              onClick={() => installPkg(p.name)}
                              style={S.btnSuccess}
                              title="Install"
                              disabled={busyPkg !== null}
                            >
                              {busyPkg?.name === p.name ? '...' : '📥'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {busyPkg && (
              <div style={S.progressWrap}>
                <span style={S.progressLabel}>
                  {busyPkg.op === 'install' ? '📥 Installing' : '🗑️ Removing'} {busyPkg.name}...
                </span>
                <div style={S.progressTrack}>
                  <div style={S.progressBar} />
                </div>
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
            {updating && (
              <>
                <div style={S.warningBanner}>
                  Do not leave this page while the system update is in progress.
                  Navigating away may interrupt the update and leave the system in an inconsistent state.
                </div>
                <div style={S.progressWrap}>
                  <span style={S.progressLabel}>⬆️ Updating system packages...</span>
                  <div style={S.progressTrack}>
                    <div style={S.progressBar} />
                  </div>
                </div>
              </>
            )}
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
                {(backend === 'pacman' || backend === 'apt') && (
                  <input
                    type="text"
                    placeholder={backend === 'pacman' ? 'Repository name' : 'File name (e.g. docker, custom)'}
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
              {backend === 'apt' && (
                <p style={S.formHint}>
                  For non-PPA repos, the file name determines the .list file in /etc/apt/sources.list.d/
                </p>
              )}
            </div>

            {/* ── APT: grouped by file ── */}
            {backend === 'apt' && (() => {
              const mainRepos = repos.filter(r => r.file === '/etc/apt/sources.list');
              const dropinFiles = new Map<string, RepoInfo[]>();
              for (const r of repos) {
                if (r.file && r.file !== '/etc/apt/sources.list') {
                  const list = dropinFiles.get(r.file) || [];
                  list.push(r);
                  dropinFiles.set(r.file, list);
                }
              }
              return (
                <>
                  {/* Main sources.list */}
                  {mainRepos.length > 0 && (
                    <div style={S.repoSection}>
                      <div style={S.repoSectionHeader}>
                        <span style={S.repoSectionIcon}>📄</span>
                        <span style={S.repoSectionTitle}>/etc/apt/sources.list</span>
                        <span style={S.repoSectionBadge}>system</span>
                      </div>
                      <div style={S.tableWrap}>
                        <table style={S.table}>
                          <thead>
                            <tr>
                              <th style={S.th}>Source Line</th>
                              <th style={{ ...S.th, width: 100 }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {mainRepos.map((r, i) => (
                              <tr key={'main-' + i} style={S.tr}>
                                <td style={S.tdMono}>{r.line || '—'}</td>
                                <td style={S.td}>
                                  <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e' }}>
                                    {r.enabled ? '● Enabled' : '○ Disabled'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Drop-in files */}
                  {dropinFiles.size > 0 && (
                    <div style={S.repoSection}>
                      <div style={S.repoSectionHeader}>
                        <span style={S.repoSectionIcon}>📂</span>
                        <span style={S.repoSectionTitle}>/etc/apt/sources.list.d/</span>
                        <span style={S.repoSectionCount}>{dropinFiles.size} file{dropinFiles.size !== 1 ? 's' : ''}</span>
                      </div>
                      {[...dropinFiles.entries()].map(([file, entries]) => (
                        <div key={file} style={S.dropinCard}>
                          <div style={S.dropinHeader}>
                            <span style={S.dropinFileName}>
                              {file.replace('/etc/apt/sources.list.d/', '')}
                            </span>
                            <span style={S.dropinFormat}>
                              {entries[0]?.format === 'deb822' ? 'DEB822' : 'one-line'}
                            </span>
                            <button
                              onClick={() => removeRepo(file)}
                              style={S.btnDanger}
                              title={`Remove ${file.replace('/etc/apt/sources.list.d/', '')}`}
                            >
                              🗑️ Remove file
                            </button>
                          </div>
                          {entries.map((r, i) => (
                            r.format === 'deb822' ? (
                              <div key={i} style={S.deb822Card}>
                                <div style={S.deb822Row}>
                                  <span style={S.deb822Label}>Types</span>
                                  <span style={S.deb822Value}>{r.Types || '—'}</span>
                                </div>
                                <div style={S.deb822Row}>
                                  <span style={S.deb822Label}>URIs</span>
                                  <span style={S.deb822Value}>{r.URIs || '—'}</span>
                                </div>
                                <div style={S.deb822Row}>
                                  <span style={S.deb822Label}>Suites</span>
                                  <span style={S.deb822Value}>{r.Suites || '—'}</span>
                                </div>
                                <div style={S.deb822Row}>
                                  <span style={S.deb822Label}>Components</span>
                                  <span style={S.deb822Value}>{r.Components || '—'}</span>
                                </div>
                                <div style={S.deb822Row}>
                                  <span style={S.deb822Label}>Status</span>
                                  <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e' }}>
                                    {r.enabled ? '● Enabled' : '○ Disabled'}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div key={i} style={S.dropinLine}>
                                <span style={S.dropinLineMono}>{r.line || '—'}</span>
                                <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e', fontSize: '0.8rem', flexShrink: 0 }}>
                                  {r.enabled ? '● Enabled' : '○ Disabled'}
                                </span>
                              </div>
                            )
                          ))}
                        </div>
                      ))}
                    </div>
                  )}

                  {repos.length === 0 && !loading && (
                    <div style={S.emptyState}>No repositories found</div>
                  )}
                </>
              );
            })()}

            {/* ── Pacman: official vs custom ── */}
            {backend === 'pacman' && (() => {
              const officialNames = ['core', 'extra', 'multilib', 'community', 'testing', 'multilib-testing', 'community-testing'];
              const official = repos.filter(r => officialNames.includes(r.name));
              const custom = repos.filter(r => !officialNames.includes(r.name));
              return (
                <>
                  {/* Official repos */}
                  {official.length > 0 && (
                    <div style={S.repoSection}>
                      <div style={S.repoSectionHeader}>
                        <span style={S.repoSectionIcon}>📄</span>
                        <span style={S.repoSectionTitle}>Official Repositories</span>
                        <span style={S.repoSectionBadge}>system</span>
                      </div>
                      <div style={S.tableWrap}>
                        <table style={S.table}>
                          <thead>
                            <tr>
                              <th style={S.th}>Name</th>
                              <th style={S.th}>Server / Include</th>
                              <th style={S.th}>SigLevel</th>
                              <th style={{ ...S.th, width: 100 }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {official.map((r, i) => (
                              <tr key={'off-' + i} style={S.tr}>
                                <td style={{ ...S.td, fontWeight: 600 }}>{r.name}</td>
                                <td style={{ ...S.tdMono, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                                  {r.server || r.include || '—'}
                                </td>
                                <td style={S.tdMono}>{r.sig_level || '—'}</td>
                                <td style={S.td}>
                                  <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e' }}>
                                    {r.enabled ? '● Enabled' : '○ Disabled'}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Custom repos */}
                  <div style={S.repoSection}>
                    <div style={S.repoSectionHeader}>
                      <span style={S.repoSectionIcon}>📦</span>
                      <span style={S.repoSectionTitle}>Custom Repositories</span>
                      {custom.length > 0 && (
                        <span style={S.repoSectionCount}>{custom.length} repo{custom.length !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                    {custom.length > 0 ? (
                      <div style={S.tableWrap}>
                        <table style={S.table}>
                          <thead>
                            <tr>
                              <th style={S.th}>Name</th>
                              <th style={S.th}>Server / Include</th>
                              <th style={S.th}>SigLevel</th>
                              <th style={{ ...S.th, width: 100 }}>Status</th>
                              <th style={{ ...S.th, width: 80 }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {custom.map((r, i) => (
                              <tr key={'cust-' + i} style={S.tr}>
                                <td style={{ ...S.td, fontWeight: 600 }}>{r.name}</td>
                                <td style={{ ...S.tdMono, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                                  {r.server || r.include || '—'}
                                </td>
                                <td style={S.tdMono}>{r.sig_level || '—'}</td>
                                <td style={S.td}>
                                  <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e' }}>
                                    {r.enabled ? '● Enabled' : '○ Disabled'}
                                  </span>
                                </td>
                                <td style={S.td}>
                                  <button onClick={() => removeRepo(r.name)} style={S.btnDanger} title="Remove">
                                    🗑️
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div style={S.emptyState}>No custom repositories configured</div>
                    )}
                  </div>
                </>
              );
            })()}

            {/* ── DNF: flat list ── */}
            {backend === 'dnf' && (
              <div style={S.repoSection}>
                <div style={S.repoSectionHeader}>
                  <span style={S.repoSectionIcon}>📦</span>
                  <span style={S.repoSectionTitle}>DNF Repositories</span>
                  <span style={S.repoSectionCount}>{repos.length} repo{repos.length !== 1 ? 's' : ''}</span>
                </div>
                {repos.length > 0 ? (
                  <div style={S.tableWrap}>
                    <table style={S.table}>
                      <thead>
                        <tr>
                          <th style={S.th}>ID</th>
                          <th style={S.th}>Description</th>
                          <th style={{ ...S.th, width: 100 }}>Status</th>
                          <th style={{ ...S.th, width: 80 }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {repos.map((r, i) => (
                          <tr key={'dnf-' + i} style={S.tr}>
                            <td style={{ ...S.td, fontWeight: 600 }}>{r.name}</td>
                            <td style={S.td}>{r.description || '—'}</td>
                            <td style={S.td}>
                              <span style={{ color: r.enabled ? '#9ece6a' : '#f7768e' }}>
                                {r.enabled ? '● Enabled' : '○ Disabled'}
                              </span>
                            </td>
                            <td style={S.td}>
                              <button onClick={() => removeRepo(r.name)} style={S.btnDanger} title="Remove">
                                🗑️
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={S.emptyState}>No repositories found</div>
                )}
              </div>
            )}

            {/* Fallback for unknown or no backend */}
            {backend !== 'apt' && backend !== 'pacman' && backend !== 'dnf' && repos.length === 0 && !loading && (
              <div style={S.emptyState}>No package manager detected</div>
            )}
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
  // ── Repo section styles ──
  repoSection: {
    marginBottom: '1.25rem',
  },
  repoSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0',
    borderBottom: '1px solid var(--border)',
    marginBottom: '0.5rem',
  },
  repoSectionIcon: {
    fontSize: '1rem',
  },
  repoSectionTitle: {
    color: 'var(--text-primary)',
    fontWeight: 600,
    fontSize: '0.95rem',
  },
  repoSectionBadge: {
    background: 'rgba(122,162,247,0.15)',
    color: '#7aa2f7',
    padding: '1px 8px',
    borderRadius: 8,
    fontSize: '0.7rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  repoSectionCount: {
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    marginLeft: 'auto',
  },
  // ── APT drop-in card styles ──
  dropinCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    marginBottom: '0.5rem',
    overflow: 'hidden',
  },
  dropinHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.75rem',
    background: 'rgba(65,72,104,0.15)',
    borderBottom: '1px solid var(--border)',
  },
  dropinFileName: {
    color: '#e0af68',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    fontWeight: 600,
  },
  dropinFormat: {
    color: 'var(--text-secondary)',
    fontSize: '0.7rem',
    background: 'rgba(65,72,104,0.3)',
    padding: '1px 6px',
    borderRadius: 6,
    marginRight: 'auto',
  },
  dropinLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.4rem 0.75rem',
    borderBottom: '1px solid rgba(65,72,104,0.2)',
  },
  dropinLineMono: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    color: 'var(--text-primary)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  // ── DEB822 card styles ──
  deb822Card: {
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid rgba(65,72,104,0.2)',
  },
  deb822Row: {
    display: 'flex',
    gap: '0.75rem',
    padding: '2px 0',
  },
  deb822Label: {
    color: '#7aa2f7',
    fontSize: '0.8rem',
    fontWeight: 600,
    minWidth: 90,
    flexShrink: 0,
  },
  deb822Value: {
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    fontSize: '0.8rem',
  },
  formHint: {
    color: 'var(--text-secondary)',
    fontSize: '0.75rem',
    margin: '0.4rem 0 0 0',
    fontStyle: 'italic' as const,
  },
  warningBanner: {
    background: 'rgba(224,175,104,0.15)',
    border: '1px solid #e0af68',
    color: '#e0af68',
    padding: '0.6rem 1rem',
    borderRadius: 8,
    fontSize: '0.85rem',
    marginBottom: '0.5rem',
    fontWeight: 500,
  },
  // ── Progress bar styles ──
  progressWrap: {
    padding: '0.75rem 0',
  },
  progressLabel: {
    display: 'block',
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    marginBottom: '0.4rem',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    background: 'rgba(122,162,247,0.1)',
    overflow: 'hidden',
    position: 'relative' as const,
  },
  progressBar: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: '50%',
    height: '100%',
    borderRadius: 2,
    background: 'linear-gradient(90deg, transparent, #7aa2f7, transparent)',
    animation: 'progress-slide 1.2s ease-in-out infinite',
  },
};
