import { useEffect, useState, useCallback, useRef } from 'react';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';

/* ── types ─────────────────────────────────────────────── */

interface Container {
  Id?: string;
  ID?: string;
  Names?: string | string[];
  Name?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Created?: string | number;
  Ports?: unknown;
  Command?: string | string[];
  _owner?: string;
}

interface ContainerImage {
  Id?: string;
  ID?: string;
  Repository?: string;
  RepoTags?: string[];
  Tag?: string;
  Size?: number;
  Created?: string | number;
  _owner?: string;
}

interface ServiceStatus {
  service: string;
  active: string;
  enabled: string;
}

type Tab = 'containers' | 'images' | 'create';

/* ── column sorting ───────────────────────────────────── */
type SortDir = 'asc' | 'desc' | null;

const CTR_STATE_ORDER: Record<string, number> = { running: 0, paused: 1, restarting: 2, created: 3, exited: 4, dead: 5 };
const OWNER_ORDER: Record<string, number> = { user: 0, root: 1 };

function nextDir(current: SortDir): SortDir {
  if (current === null) return 'desc';
  if (current === 'desc') return 'asc';
  return null;
}

function sortArrow(dir: SortDir): string {
  if (dir === 'desc') return ' \u25BC';
  if (dir === 'asc') return ' \u25B2';
  return '';
}

/* ── helpers ───────────────────────────────────────────── */

function friendlyError(action: string, raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('image is being used by running container')) {
    const m = raw.match(/running container ([a-f0-9]+)/i);
    const cid = m ? m[1].slice(0, 12) : '';
    return `Cannot remove image — it is used by a running container${cid ? ` (${cid})` : ''}. Stop the container first.`;
  }
  if (lower.includes('image is being used by') || lower.includes('image has dependent child')) {
    return `Cannot remove image — it is in use. Remove dependent containers first.`;
  }
  if (lower.includes('is already in progress')) {
    return `Operation already in progress. Please wait.`;
  }
  if (lower.includes('no such container')) {
    return `Container not found — it may have already been removed.`;
  }
  if (lower.includes('no such image')) {
    return `Image not found — it may have already been removed.`;
  }
  if (lower.includes('authentication failed') || lower.includes('incorrect password')) {
    return `Authentication failed — check your password.`;
  }
  return `${action}: ${raw}`;
}

function getId(c: Container | ContainerImage): string {
  return (c.Id || c.ID || '').slice(0, 12);
}

function getContainerName(c: Container): string {
  if (c.Names) {
    if (Array.isArray(c.Names)) return c.Names[0]?.replace(/^\//, '') || '';
    return String(c.Names).replace(/^\//, '');
  }
  if (c.Name) return c.Name.replace(/^\//, '');
  return getId(c);
}

function getImageName(img: ContainerImage): string {
  if (img.RepoTags && img.RepoTags.length > 0) return img.RepoTags[0];
  if (img.Repository) return `${img.Repository}:${img.Tag || 'latest'}`;
  return getId(img);
}

function formatSize(bytes?: number | string): string {
  if (bytes == null) return '—';
  if (typeof bytes === 'string') return bytes || '—';
  if (!bytes) return '—';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function stateColor(state?: string): string {
  const s = (state || '').toLowerCase();
  if (s === 'running') return '#9ece6a';
  if (s === 'exited' || s === 'dead') return '#f7768e';
  if (s === 'paused') return '#e0af68';
  if (s === 'created' || s === 'restarting') return '#7aa2f7';
  return '#565f89';
}

function ownerColor(owner?: string): string {
  return owner === 'root' ? '#9ece6a' : '#e0af68';
}

/* ── component ─────────────────────────────────────────── */

export function Containers() {
  const { openChannel } = useTransport();
  const su = useSuperuser();
  const [runtime, setRuntime] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<ContainerImage[]>([]);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const saved = sessionStorage.getItem('ctr_tab');
    return (saved === 'images' || saved === 'create') ? saved : 'containers';
  });
  const changeTab = (t: Tab) => { setTab(t); sessionStorage.setItem('ctr_tab', t); };
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; id?: string; label: string; extra?: Record<string, unknown> } | null>(null);
  const [password, setPassword] = useState('');
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  // Create form state
  const [form, setForm] = useState({
    image: '',
    name: '',
    ports: [{ host: '', container: '' }],
    env: [{ key: '', value: '' }],
    volumes: [{ host: '', container: '' }],
    restart: '',
    command: '',
  });
  const [pullImage, setPullImage] = useState('');
  const [pulling, setPulling] = useState<string | null>(null);

  // Inline confirmation for remove actions (replaces browser confirm())
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  // Search state — containers tab
  const [ctrSearch, setCtrSearch] = useState('');

  // Sorting state — containers tab
  const [ctrSortCol, setCtrSortCol] = useState<'name' | 'state' | 'owner' | null>(null);
  const [ctrSortDir, setCtrSortDir] = useState<SortDir>(null);
  // Sorting state — images tab
  const [imgSortCol, setImgSortCol] = useState<'owner' | null>(null);
  const [imgSortDir, setImgSortDir] = useState<SortDir>(null);

  const handleCtrSort = (col: 'name' | 'state' | 'owner') => {
    if (ctrSortCol === col) {
      const nd = nextDir(ctrSortDir);
      setCtrSortDir(nd);
      if (nd === null) setCtrSortCol(null);
    } else {
      setCtrSortCol(col);
      setCtrSortDir('desc');
    }
  };

  const handleImgSort = (col: 'owner') => {
    if (imgSortCol === col) {
      const nd = nextDir(imgSortDir);
      setImgSortDir(nd);
      if (nd === null) setImgSortCol(null);
    } else {
      setImgSortCol(col);
      setImgSortDir('desc');
    }
  };

  const sortedContainers = (() => {
    // Filter by search query (case-insensitive substring match on name)
    const needle = ctrSearch.toLowerCase();
    const filtered = needle
      ? containers.filter(c => getContainerName(c).toLowerCase().includes(needle))
      : containers;

    if (!ctrSortCol || !ctrSortDir) return filtered;
    const sorted = [...filtered];
    const mul = ctrSortDir === 'desc' ? 1 : -1;
    if (ctrSortCol === 'name') {
      sorted.sort((a, b) => mul * getContainerName(a).localeCompare(getContainerName(b)));
    } else if (ctrSortCol === 'state') {
      sorted.sort((a, b) => mul * ((CTR_STATE_ORDER[(a.State || '').toLowerCase()] ?? 99) - (CTR_STATE_ORDER[(b.State || '').toLowerCase()] ?? 99)));
    } else {
      sorted.sort((a, b) => mul * ((OWNER_ORDER[a._owner || 'user'] ?? 99) - (OWNER_ORDER[b._owner || 'user'] ?? 99)));
    }
    return sorted;
  })();

  const sortedImages = (() => {
    if (!imgSortCol || !imgSortDir) return images;
    const sorted = [...images];
    const mul = imgSortDir === 'desc' ? 1 : -1;
    sorted.sort((a, b) => mul * ((OWNER_ORDER[a._owner || 'user'] ?? 99) - (OWNER_ORDER[b._owner || 'user'] ?? 99)));
    return sorted;
  })();

  // Track superuser state via ref to avoid channel re-creation on toggle
  const suRef = useRef(su);
  suRef.current = su;

  const sendAction = useCallback((action: string, extra: Record<string, unknown> = {}) => {
    const payload: Record<string, unknown> = { action, ...extra };
    const s = suRef.current;
    if (s.active && s.password && !('password' in extra)) {
      payload.password = s.password;
    }
    channelRef.current?.send(payload);
  }, []);

  const refresh = useCallback(() => {
    sendAction('list_containers');
    sendAction('list_images');
    sendAction('service_status');
  }, [sendAction]);

  useEffect(() => {
    setRuntime(null);
    setAvailable(null);
    setContainers([]);
    setImages([]);
    setService(null);
    setError(null);
    setLogs(null);
    setPulling(null);
    setCtrSearch('');
    setConfirmingRemove(null);

    const ch = openChannel('container.manage');
    channelRef.current = ch;

    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;

        if (d.type === 'init') {
          setRuntime(d.runtime as string | null);
          const info = d.info as Record<string, unknown>;
          setAvailable(!!info?.available);
          if (info?.service) setService(info.service as ServiceStatus);
          // Fetch containers and images
          if (info?.available) {
            sendAction('list_containers');
            sendAction('list_images');
          }
        }

        if (d.type === 'response') {
          setLoading(false);
          const action = d.action as string;
          const data = d.data as Record<string, unknown>;

          if (action === 'list_containers') {
            if (Array.isArray(data)) {
              setContainers(data as Container[]);
            } else if (data?.error) {
              setError(String(data.error));
            }
          } else if (action === 'list_images') {
            if (Array.isArray(data)) {
              setImages(data as ContainerImage[]);
            } else if (data?.error) {
              setError(String(data.error));
            }
          } else if (action === 'logs') {
            if (data?.logs != null) {
              const id = data.id as string || '';
              setLogs({ id, text: String(data.logs) });
            }
          } else if (action === 'service_status') {
            setService(data as unknown as ServiceStatus);
          } else if (['start', 'stop', 'restart', 'remove', 'remove_image', 'pull', 'create'].includes(action)) {
            if (action === 'pull') setPulling(null);
            if (data && typeof data === 'object' && 'error' in data && data.error) {
              setError(friendlyError(action, String(data.error)));
            }
            // Refresh after any mutation
            setTimeout(() => refresh(), 150);
          } else if (['service_start', 'service_stop', 'service_restart'].includes(action)) {
            setTimeout(() => sendAction('service_status'), 150);
          }
        }

        if (d.type === 'error') {
          setError(String(d.error));
          setLoading(false);
          setPulling(null);
        }
      }
    });

    return () => ch.close();
  }, [openChannel, refresh, sendAction]);

  // Re-fetch containers when superuser mode changes (to show/hide root containers)
  const prevSuActive = useRef(su.active);
  useEffect(() => {
    if (su.active !== prevSuActive.current) {
      prevSuActive.current = su.active;
      if (available) refresh();
    }
  }, [su.active, available, refresh]);

  const requestPrivileged = (action: string, label: string, id?: string, extra?: Record<string, unknown>) => {
    if (su.active) {
      /* superuser mode — execute immediately with stored password */
      setLoading(true);
      setError(null);
      const payload: Record<string, unknown> = { ...extra };
      if (id) payload.id = id;
      sendAction(action, payload);
      return;
    }
    setPendingAction({ action, id, label, extra });
    setPassword('');
    setError(null);
  };

  const confirmAction = () => {
    if (!pendingAction || !password) return;
    setLoading(true);
    setError(null);
    const payload: Record<string, unknown> = { password, ...pendingAction.extra };
    if (pendingAction.id) payload.id = pendingAction.id;
    sendAction(pendingAction.action, payload);
    setPendingAction(null);
    setPassword('');
  };

  const cancelAction = () => {
    setPendingAction(null);
    setPassword('');
  };

  const handleCreate = () => {
    requestPrivileged('create', 'Create container', undefined, {
      image: form.image,
      name: form.name,
      ports: form.ports.filter(p => p.host && p.container),
      env: form.env.filter(e => e.key),
      volumes: form.volumes.filter(v => v.host && v.container),
      restart: form.restart,
      command: form.command,
    });
    setForm({
      image: '', name: '', ports: [{ host: '', container: '' }],
      env: [{ key: '', value: '' }], volumes: [{ host: '', container: '' }],
      restart: '', command: '',
    });
    changeTab('containers');
  };

  const handlePull = () => {
    if (!pullImage.trim()) return;
    const imageName = pullImage.trim();
    setPulling(imageName);
    requestPrivileged('pull', `Pull ${imageName}`, undefined, { image: imageName });
    setPullImage('');
  };

  /* ── render ──────────────────────────────────────────── */

  if (available === null) {
    return <div><h2>Containers</h2><p style={S.muted}>Detecting container runtime…</p></div>;
  }

  if (!available) {
    return (
      <div>
        <h2>Containers</h2>
        <div style={S.card}>
          <p style={{ color: '#f7768e' }}>No container runtime detected.</p>
          <p style={S.muted}>Install <strong>podman</strong> or <strong>docker</strong> to manage containers.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={S.header}>
        <h2>Containers</h2>
        <span style={S.runtimeBadge}>{runtime}</span>
      </div>

      {error && (
        <div style={S.error}>
          {error}
          <button onClick={() => setError(null)} style={S.errorClose}>✕</button>
        </div>
      )}

      {/* Service control */}
      {service && (
        <div style={S.serviceBar}>
          <span style={S.muted}>Service: <strong style={{ color: 'var(--text-primary)' }}>{service.service}</strong></span>
          <span style={{
            ...S.stateBadge,
            background: service.active === 'active' ? '#9ece6a22' : '#f7768e22',
            color: service.active === 'active' ? '#9ece6a' : '#f7768e',
          }}>{service.active}</span>
          <span style={{ ...S.stateBadge, background: '#7aa2f722', color: '#7aa2f7' }}>{service.enabled}</span>
          <div style={{ flex: 1 }} />
          <button style={S.btn} onClick={() => requestPrivileged('service_start', `Start ${service.service}`)}>Start</button>
          <button style={S.btn} onClick={() => requestPrivileged('service_stop', `Stop ${service.service}`)}>Stop</button>
          <button style={S.btn} onClick={() => requestPrivileged('service_restart', `Restart ${service.service}`)}>Restart</button>
        </div>
      )}

      {/* Password prompt */}
      {pendingAction && (
        <div style={S.passwordBar}>
          <span style={S.passwordLabel}>
            Password required for <b>{pendingAction.label}</b>:
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmAction(); if (e.key === 'Escape') cancelAction(); }}
            placeholder="Enter password…"
            autoFocus
            style={{ ...S.passwordInput, borderColor: password ? '#7aa2f7' : '#9ece6a' }}
          />
          <button
            onClick={confirmAction}
            disabled={!password}
            style={{
              ...S.confirmBtn,
              opacity: password ? 1 : 0.4,
              cursor: password ? 'pointer' : 'default',
            }}
          >
            Confirm
          </button>
          <button onClick={cancelAction} style={S.cancelBtn}>Cancel</button>
        </div>
      )}

      {/* Ownership info banner */}
      <div style={S.infoBanner}>
        {su.active
          ? 'Showing user and root containers. Owner column indicates who owns each container.'
          : 'Showing your containers only. Enable Administrative Access to see root containers.'}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {(['containers', 'images', 'create'] as Tab[]).map((t) => (
          <button key={t} onClick={() => changeTab(t)} style={{
            ...S.tab, ...(tab === t ? S.tabActive : {}),
          }}>{t === 'create' ? '+ New Container' : t.charAt(0).toUpperCase() + t.slice(1)}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button style={S.btn} onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Containers tab */}
      {tab === 'containers' && (
        <div style={S.card}>
          <div style={S.searchRow}>
            <input
              style={{ ...S.searchInput, borderColor: ctrSearch ? '#7aa2f7' : '#9ece6a' }}
              placeholder="Search containers by name…"
              value={ctrSearch}
              onChange={(e) => setCtrSearch(e.target.value)}
            />
            {ctrSearch && (
              <button style={S.searchClear} onClick={() => setCtrSearch('')}>✕</button>
            )}
            <span style={S.searchCount}>
              {sortedContainers.length}/{containers.length}
            </span>
          </div>
          {sortedContainers.length === 0 ? (
            <p style={S.muted}>{ctrSearch ? 'No containers match the filter.' : 'No containers found.'}</p>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.thSort} onClick={() => handleCtrSort('name')}>
                    Name{ctrSortCol === 'name' ? sortArrow(ctrSortDir) : ''}
                  </th>
                  <th style={S.th}>Image</th>
                  <th style={S.thSort} onClick={() => handleCtrSort('state')}>
                    State{ctrSortCol === 'state' ? sortArrow(ctrSortDir) : ''}
                  </th>
                  <th style={S.thSort} onClick={() => handleCtrSort('owner')}>
                    Owner{ctrSortCol === 'owner' ? sortArrow(ctrSortDir) : ''}
                  </th>
                  <th style={S.th}>Status</th>
                  <th style={S.th}>ID</th>
                  <th style={S.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedContainers.map((c) => {
                  const id = getId(c);
                  const state = (c.State || '').toLowerCase();
                  const owner = c._owner || 'user';
                  return (
                    <tr key={id + owner} style={S.tr}>
                      <td style={S.td}><strong>{getContainerName(c)}</strong></td>
                      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{c.Image}</td>
                      <td style={S.td}>
                        <span style={{ ...S.stateBadge, background: stateColor(c.State) + '22', color: stateColor(c.State) }}>
                          {c.State}
                        </span>
                      </td>
                      <td style={S.td}>
                        <span style={{ ...S.stateBadge, background: ownerColor(owner) + '22', color: ownerColor(owner) }}>
                          {owner}
                        </span>
                      </td>
                      <td style={{ ...S.td, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{c.Status}</td>
                      <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{id}</td>
                      <td style={S.td}>
                        <div style={S.actions}>
                          {state !== 'running' && (
                            <button style={S.actBtn} onClick={() => requestPrivileged('start', `Start ${getContainerName(c)}`, id, { owner })} title="Start">▶</button>
                          )}
                          {state === 'running' && (
                            <button style={S.actBtn} onClick={() => requestPrivileged('stop', `Stop ${getContainerName(c)}`, id, { owner })} title="Stop">■</button>
                          )}
                          <button style={S.actBtn} onClick={() => requestPrivileged('restart', `Restart ${getContainerName(c)}`, id, { owner })} title="Restart">↻</button>
                          <button style={S.actBtn} onClick={() => {
                            sendAction('logs', { id, tail: 200, owner });
                          }} title="Logs">📋</button>
                          {confirmingRemove === `ctr:${id}:${owner}` ? (
                            <span style={S.confirmInline}>
                              <span style={{ color: '#f7768e', fontSize: '0.75rem' }}>Sure?</span>
                              <button style={{ ...S.actBtn, color: '#f7768e', fontWeight: 600 }} onClick={() => {
                                setConfirmingRemove(null);
                                requestPrivileged('remove', `Remove ${getContainerName(c)}`, id, { force: true, owner });
                              }}>Yes</button>
                              <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                            </span>
                          ) : (
                            <button style={{ ...S.actBtn, color: '#f7768e' }} onClick={() => setConfirmingRemove(`ctr:${id}:${owner}`)} title="Remove">✕</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Images tab */}
      {tab === 'images' && (
        <div>
          <div style={{ ...S.card, marginBottom: '1rem' }}>
            <div style={S.pullRow}>
              <input
                style={{ ...S.input, borderColor: pullImage ? '#7aa2f7' : '#9ece6a' }}
                placeholder="Image name (e.g. nginx:latest)"
                value={pullImage}
                onChange={(e) => setPullImage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePull()}
                disabled={pulling !== null}
              />
              <button style={S.btn} onClick={handlePull} disabled={loading || !pullImage.trim() || pulling !== null}>
                {pulling ? 'Pulling...' : 'Pull Image'}
              </button>
            </div>
            {pulling && (
              <div style={S.progressWrap}>
                <span style={S.progressLabel}>Pulling {pulling}...</span>
                <div style={S.progressTrack}>
                  <div style={S.progressBar} />
                </div>
              </div>
            )}
          </div>
          <div style={S.card}>
            {images.length === 0 ? (
              <p style={S.muted}>No images found.</p>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Repository:Tag</th>
                    <th style={S.thSort} onClick={() => handleImgSort('owner')}>
                      Owner{imgSortCol === 'owner' ? sortArrow(imgSortDir) : ''}
                    </th>
                    <th style={S.th}>ID</th>
                    <th style={S.th}>Size</th>
                    <th style={S.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedImages.map((img) => {
                    const id = getId(img);
                    const owner = img._owner || 'user';
                    return (
                      <tr key={id + owner + getImageName(img)} style={S.tr}>
                        <td style={S.td}><strong>{getImageName(img)}</strong></td>
                        <td style={S.td}>
                          <span style={{ ...S.stateBadge, background: ownerColor(owner) + '22', color: ownerColor(owner) }}>
                            {owner}
                          </span>
                        </td>
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{id}</td>
                        <td style={S.td}>{formatSize(img.Size)}</td>
                        <td style={S.td}>
                          {confirmingRemove === `img:${id}:${owner}` ? (
                            <span style={S.confirmInline}>
                              <span style={{ color: '#f7768e', fontSize: '0.75rem' }}>Sure?</span>
                              <button style={{ ...S.actBtn, color: '#f7768e', fontWeight: 600 }} onClick={() => {
                                setConfirmingRemove(null);
                                requestPrivileged('remove_image', `Remove image ${getImageName(img)}`, id, { force: true, owner });
                              }}>Yes</button>
                              <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                            </span>
                          ) : (
                            <button style={{ ...S.actBtn, color: '#f7768e' }} onClick={() => setConfirmingRemove(`img:${id}:${owner}`)} title="Remove">✕</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Create tab */}
      {tab === 'create' && (
        <div style={S.card}>
          <h3 style={S.formTitle}>Create New Container</h3>
          <div style={S.formGrid}>
            <label style={S.label}>Image *
              <input style={{ ...S.input, borderColor: form.image ? '#7aa2f7' : '#9ece6a' }} placeholder="nginx:latest" value={form.image}
                onChange={(e) => setForm({ ...form, image: e.target.value })} />
            </label>
            <label style={S.label}>Name
              <input style={{ ...S.input, borderColor: form.name ? '#7aa2f7' : '#9ece6a' }} placeholder="my-container" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
          </div>

          <div style={S.section}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>Port Mappings</span>
              <button style={S.addBtn} onClick={() =>
                setForm({ ...form, ports: [...form.ports, { host: '', container: '' }] })
              }>+ Add</button>
            </div>
            {form.ports.map((p, i) => (
              <div key={i} style={S.pairRow}>
                <input style={{ ...S.inputSm, borderColor: p.host ? '#7aa2f7' : '#9ece6a' }} placeholder="Host port" value={p.host}
                  onChange={(e) => { const ports = [...form.ports]; ports[i] = { ...p, host: e.target.value }; setForm({ ...form, ports }); }} />
                <span style={S.muted}>→</span>
                <input style={{ ...S.inputSm, borderColor: p.container ? '#7aa2f7' : '#9ece6a' }} placeholder="Container port" value={p.container}
                  onChange={(e) => { const ports = [...form.ports]; ports[i] = { ...p, container: e.target.value }; setForm({ ...form, ports }); }} />
                {form.ports.length > 1 && (
                  <button style={S.rmBtn} onClick={() => {
                    const ports = form.ports.filter((_, j) => j !== i); setForm({ ...form, ports });
                  }}>✕</button>
                )}
              </div>
            ))}
          </div>

          <div style={S.section}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>Environment Variables</span>
              <button style={S.addBtn} onClick={() =>
                setForm({ ...form, env: [...form.env, { key: '', value: '' }] })
              }>+ Add</button>
            </div>
            {form.env.map((e, i) => (
              <div key={i} style={S.pairRow}>
                <input style={{ ...S.inputSm, borderColor: e.key ? '#7aa2f7' : '#9ece6a' }} placeholder="KEY" value={e.key}
                  onChange={(ev) => { const env = [...form.env]; env[i] = { ...e, key: ev.target.value }; setForm({ ...form, env }); }} />
                <span style={S.muted}>=</span>
                <input style={{ ...S.inputSm, borderColor: e.value ? '#7aa2f7' : '#9ece6a' }} placeholder="value" value={e.value}
                  onChange={(ev) => { const env = [...form.env]; env[i] = { ...e, value: ev.target.value }; setForm({ ...form, env }); }} />
                {form.env.length > 1 && (
                  <button style={S.rmBtn} onClick={() => {
                    const env = form.env.filter((_, j) => j !== i); setForm({ ...form, env });
                  }}>✕</button>
                )}
              </div>
            ))}
          </div>

          <div style={S.section}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>Volume Mounts</span>
              <button style={S.addBtn} onClick={() =>
                setForm({ ...form, volumes: [...form.volumes, { host: '', container: '' }] })
              }>+ Add</button>
            </div>
            {form.volumes.map((v, i) => (
              <div key={i} style={S.pairRow}>
                <input style={{ ...S.inputSm, borderColor: v.host ? '#7aa2f7' : '#9ece6a' }} placeholder="Host path" value={v.host}
                  onChange={(e) => { const volumes = [...form.volumes]; volumes[i] = { ...v, host: e.target.value }; setForm({ ...form, volumes }); }} />
                <span style={S.muted}>→</span>
                <input style={{ ...S.inputSm, borderColor: v.container ? '#7aa2f7' : '#9ece6a' }} placeholder="Container path" value={v.container}
                  onChange={(e) => { const volumes = [...form.volumes]; volumes[i] = { ...v, container: e.target.value }; setForm({ ...form, volumes }); }} />
                {form.volumes.length > 1 && (
                  <button style={S.rmBtn} onClick={() => {
                    const volumes = form.volumes.filter((_, j) => j !== i); setForm({ ...form, volumes });
                  }}>✕</button>
                )}
              </div>
            ))}
          </div>

          <div style={S.formGrid}>
            <label style={S.label}>Restart Policy
              <select style={{ ...S.input, borderColor: form.restart ? '#7aa2f7' : '#9ece6a' }} value={form.restart}
                onChange={(e) => setForm({ ...form, restart: e.target.value })}>
                <option value="">None</option>
                <option value="always">Always</option>
                <option value="unless-stopped">Unless Stopped</option>
                <option value="on-failure">On Failure</option>
              </select>
            </label>
            <label style={S.label}>Command (optional)
              <input style={{ ...S.input, borderColor: form.command ? '#7aa2f7' : '#9ece6a' }} placeholder="e.g. /bin/sh -c 'echo hello'" value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })} />
            </label>
          </div>

          <button style={{ ...S.btn, marginTop: '1rem', padding: '0.6rem 2rem' }}
            onClick={handleCreate} disabled={!form.image || loading}>
            Create & Start
          </button>
        </div>
      )}

      {/* Logs modal */}
      {logs && (
        <div style={S.overlay} onClick={() => setLogs(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Logs: {logs.id}</h3>
              <button style={S.actBtn} onClick={() => setLogs(null)}>✕</button>
            </div>
            <pre style={S.logsPre}>{logs.text || '(empty)'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '1rem',
  },
  runtimeBadge: {
    background: '#7aa2f722',
    color: '#7aa2f7',
    padding: '0.2rem 0.6rem',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
  },
  card: {
    background: 'var(--bg-secondary)',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
  },
  error: {
    background: '#f7768e22',
    border: '1px solid #f7768e44',
    borderRadius: 6,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    color: '#f7768e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '0.85rem',
  },
  errorClose: {
    background: 'none',
    border: 'none',
    color: '#f7768e',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  serviceBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    background: 'var(--bg-secondary)',
    borderRadius: 8,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    flexWrap: 'wrap' as const,
  },
  stateBadge: {
    padding: '0.15rem 0.5rem',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    marginBottom: '1rem',
    alignItems: 'center',
  },
  tab: {
    padding: '0.45rem 1rem',
    borderRadius: '6px 6px 0 0',
    border: 'none',
    background: 'var(--bg-secondary)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  tabActive: {
    background: 'var(--accent)',
    color: '#fff',
  },
  btn: {
    padding: '0.35rem 0.75rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.85rem',
  },
  th: {
    textAlign: 'left' as const,
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  thSort: {
    textAlign: 'left' as const,
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  },
  tr: {
    borderBottom: '1px solid #292e42',
  },
  td: {
    padding: '0.5rem 0.75rem',
    verticalAlign: 'middle' as const,
  },
  actions: {
    display: 'flex',
    gap: '0.25rem',
  },
  actBtn: {
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    padding: '0.2rem 0.4rem',
    fontSize: '0.8rem',
  },
  pullRow: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
  },
  // Create form
  formTitle: {
    marginBottom: '1rem',
    fontSize: '0.95rem',
    fontWeight: 600,
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
    marginBottom: '0.5rem',
  },
  label: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.3rem',
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
  },
  input: {
    padding: '0.4rem 0.6rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    outline: 'none',
  },
  inputSm: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.8rem',
    outline: 'none',
    flex: 1,
    minWidth: 0,
  },
  section: {
    marginTop: '0.75rem',
    marginBottom: '0.5rem',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.4rem',
  },
  sectionTitle: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  addBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--accent)',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
  },
  rmBtn: {
    background: 'none',
    border: 'none',
    color: '#f7768e',
    cursor: 'pointer',
    fontSize: '0.85rem',
    padding: '0 0.3rem',
  },
  pairRow: {
    display: 'flex',
    gap: '0.4rem',
    alignItems: 'center',
    marginBottom: '0.3rem',
  },
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-secondary)',
    borderRadius: 10,
    padding: '1rem 1.25rem',
    width: '80vw',
    maxWidth: 900,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.75rem',
  },
  logsPre: {
    background: 'var(--bg-primary)',
    borderRadius: 6,
    padding: '0.75rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    overflow: 'auto',
    flex: 1,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    maxHeight: '60vh',
    color: 'var(--text-primary)',
  },
  passwordBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    background: 'var(--bg-secondary)',
    borderRadius: 8,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    flexWrap: 'wrap' as const,
  },
  passwordLabel: {
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap' as const,
  },
  passwordInput: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    width: 200,
  },
  confirmBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid #9ece6a66',
    background: '#9ece6a22',
    color: '#9ece6a',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  infoBanner: {
    background: '#7aa2f711',
    border: '1px solid #7aa2f733',
    borderRadius: 6,
    padding: '0.4rem 0.75rem',
    marginBottom: '0.75rem',
    color: '#7aa2f7',
    fontSize: '0.8rem',
  },
  // ── Search styles ──
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
  },
  searchInput: {
    padding: '0.4rem 0.6rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    outline: 'none',
    flex: 1,
    minWidth: 0,
  },
  searchClear: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.9rem',
    padding: '0 0.2rem',
  },
  searchCount: {
    color: 'var(--text-secondary)',
    fontSize: '0.75rem',
    whiteSpace: 'nowrap' as const,
  },
  // ── Inline confirmation ──
  confirmInline: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
  },
  // ── Progress bar styles ──
  progressWrap: {
    padding: '0.75rem 0 0.25rem',
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
