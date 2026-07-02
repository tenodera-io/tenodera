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

interface Volume {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;   // Docker
  MountPoint?: string;   // Podman
  Scope?: string;
  _owner?: string;
}

interface Network {
  ID?: string;
  Id?: string;
  id?: string;
  Name?: string;
  name?: string;
  Driver?: string;
  driver?: string;
  Scope?: string;
  scope?: string;
  _owner?: string;
}

interface ContainerStat {
  ID?: string;
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  NetIO?: string;
  BlockIO?: string;
}

interface ServiceStatus {
  service: string;
  active: string;
  enabled: string;
}

type Tab = 'containers' | 'images' | 'volumes' | 'networks' | 'create';

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
  if (dir === 'desc') return ' ▼';
  if (dir === 'asc') return ' ▲';
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
  if (lower.includes('pre-defined network') || lower.includes('predefined network')) {
    return `Cannot remove built-in network (bridge/host/none).`;
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

function getNetworkId(n: Network): string {
  return (n.ID || n.Id || n.id || '').slice(0, 12);
}

function getNetworkName(n: Network): string {
  return n.Name || n.name || getNetworkId(n);
}

function getNetworkDriver(n: Network): string {
  return n.Driver || n.driver || '—';
}

function getNetworkScope(n: Network): string {
  return n.Scope || n.scope || '—';
}

function getVolumeMountpoint(v: Volume): string {
  return v.Mountpoint || v.MountPoint || '—';
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
  if (s === 'running') return 'var(--c-green)';
  if (s === 'exited' || s === 'dead') return 'var(--c-red)';
  if (s === 'paused') return 'var(--c-yellow)';
  if (s === 'created' || s === 'restarting') return 'var(--c-blue)';
  return 'var(--text-3)';
}

function ownerColor(owner?: string): string {
  return owner === 'root' ? 'var(--c-green)' : 'var(--c-yellow)';
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[mGKHFJA-Za-z]/g, '');
}

/* ── component ─────────────────────────────────────────── */

export function Containers() {
  const { openChannel } = useTransport();
  const su = useSuperuser();
  const [runtime, setRuntime] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<ContainerImage[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const saved = sessionStorage.getItem('ctr_tab');
    return (['images', 'volumes', 'networks', 'create'] as string[]).includes(saved || '') ? saved as Tab : 'containers';
  });
  const changeTab = (t: Tab) => { setTab(t); sessionStorage.setItem('ctr_tab', t); };
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<{ id: string; owner: string; text: string } | null>(null);
  const [logsTail, setLogsTail] = useState(200);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; id?: string; label: string; extra?: Record<string, unknown> } | null>(null);
  const [password, setPassword] = useState('');
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  // Stats
  const [statsMap, setStatsMap] = useState<Map<string, ContainerStat>>(new Map());
  const [statsLoading, setStatsLoading] = useState(false);
  const [showStats, setShowStats] = useState(false);

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

  // Inline confirmation for remove actions
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  // Search state
  const [ctrSearch, setCtrSearch] = useState('');
  const [imgSearch, setImgSearch] = useState('');
  const [volSearch, setVolSearch] = useState('');
  const [netSearch, setNetSearch] = useState('');

  // Sorting state — containers tab
  const [ctrSortCol, setCtrSortCol] = useState<'name' | 'state' | 'owner' | null>(null);
  const [ctrSortDir, setCtrSortDir] = useState<SortDir>(null);
  // Sorting state — images tab
  const [imgSortCol, setImgSortCol] = useState<'owner' | null>(null);
  const [imgSortDir, setImgSortDir] = useState<SortDir>(null);

  const logsPreRef = useRef<HTMLPreElement | null>(null);

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
    const needle = imgSearch.toLowerCase();
    const filtered = needle
      ? images.filter(img => getImageName(img).toLowerCase().includes(needle))
      : images;
    if (!imgSortCol || !imgSortDir) return filtered;
    const sorted = [...filtered];
    const mul = imgSortDir === 'desc' ? 1 : -1;
    sorted.sort((a, b) => mul * ((OWNER_ORDER[a._owner || 'user'] ?? 99) - (OWNER_ORDER[b._owner || 'user'] ?? 99)));
    return sorted;
  })();

  const filteredVolumes = volSearch
    ? volumes.filter(v => (v.Name || '').toLowerCase().includes(volSearch.toLowerCase()))
    : volumes;

  const filteredNetworks = netSearch
    ? networks.filter(n => getNetworkName(n).toLowerCase().includes(netSearch.toLowerCase()))
    : networks;

  // Track superuser state via ref
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

  const refreshVolumes = useCallback(() => {
    sendAction('volumes_list');
  }, [sendAction]);

  const refreshNetworks = useCallback(() => {
    sendAction('networks_list');
  }, [sendAction]);

  const loadStats = useCallback(() => {
    setStatsLoading(true);
    sendAction('stats_all');
  }, [sendAction]);

  useEffect(() => {
    setRuntime(null);
    setAvailable(null);
    setContainers([]);
    setImages([]);
    setVolumes([]);
    setNetworks([]);
    setService(null);
    setError(null);
    setLogs(null);
    setPulling(null);
    setCtrSearch('');
    setImgSearch('');
    setVolSearch('');
    setNetSearch('');
    setConfirmingRemove(null);
    setStatsMap(new Map());
    setShowStats(false);

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
          } else if (action === 'volumes_list') {
            if (Array.isArray(data)) {
              setVolumes(data as Volume[]);
            } else if (data?.error) {
              setError(String(data.error));
            }
          } else if (action === 'networks_list') {
            if (Array.isArray(data)) {
              setNetworks(data as Network[]);
            } else if (data?.error) {
              setError(String(data.error));
            }
          } else if (action === 'stats_all') {
            setStatsLoading(false);
            if (Array.isArray(data)) {
              const m = new Map<string, ContainerStat>();
              for (const s of data as ContainerStat[]) {
                const id = (s.ID || s.Name || '').replace(/^\//, '').slice(0, 12);
                if (id) m.set(id, s);
                // Also index by container name for lookup
                if (s.Name) m.set(s.Name.replace(/^\//, ''), s);
              }
              setStatsMap(m);
            } else if ((data as { error?: string })?.error) {
              setStatsLoading(false);
              setError(String((data as { error: string }).error));
            }
          } else if (action === 'logs') {
            if (data?.logs != null) {
              const id = data.id as string || '';
              setLogs(prev => ({ id, owner: prev?.owner || 'user', text: String(data.logs) }));
            }
          } else if (action === 'service_status') {
            setService(data as unknown as ServiceStatus);
          } else if (['start', 'stop', 'restart', 'remove', 'remove_image', 'pull', 'create'].includes(action)) {
            if (action === 'pull') setPulling(null);
            if (data && typeof data === 'object' && 'error' in data && data.error) {
              setError(friendlyError(action, String(data.error)));
            }
            setTimeout(() => refresh(), 150);
          } else if (['volume_remove', 'volume_prune'].includes(action)) {
            if (data?.error) setError(friendlyError(action, String(data.error)));
            setTimeout(() => refreshVolumes(), 150);
          } else if (['network_remove'].includes(action)) {
            if (data?.error) setError(friendlyError(action, String(data.error)));
            setTimeout(() => refreshNetworks(), 150);
          } else if (['container_prune', 'image_prune', 'system_prune'].includes(action)) {
            if (data?.error) setError(friendlyError(action, String(data.error)));
            setTimeout(() => refresh(), 150);
          } else if (['service_start', 'service_stop', 'service_restart'].includes(action)) {
            setTimeout(() => sendAction('service_status'), 150);
          }
        }

        if (d.type === 'error') {
          setError(String(d.error));
          setLoading(false);
          setPulling(null);
          setStatsLoading(false);
        }
      }
    });

    return () => ch.close();
  }, [openChannel, refresh, refreshVolumes, refreshNetworks, sendAction]);

  // Fetch volumes/networks lazily when switching to those tabs
  const prevTab = useRef<Tab>('containers');
  useEffect(() => {
    if (tab === prevTab.current || !available) return;
    prevTab.current = tab;
    if (tab === 'volumes') refreshVolumes();
    if (tab === 'networks') refreshNetworks();
  }, [tab, available, refreshVolumes, refreshNetworks]);

  // Re-fetch when superuser mode changes
  const prevSuActive = useRef(su.active);
  useEffect(() => {
    if (su.active !== prevSuActive.current) {
      prevSuActive.current = su.active;
      if (available) {
        refresh();
        if (tab === 'volumes') refreshVolumes();
        if (tab === 'networks') refreshNetworks();
      }
    }
  }, [su.active, available, refresh, refreshVolumes, refreshNetworks, tab]);

  // Auto-scroll logs to bottom when content changes
  useEffect(() => {
    if (logs && logsPreRef.current) {
      logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
    }
  }, [logs]);

  const requestPrivileged = (action: string, label: string, id?: string, extra?: Record<string, unknown>) => {
    if (su.active) {
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

  const handleShowStats = () => {
    if (showStats) {
      setShowStats(false);
      setStatsMap(new Map());
    } else {
      setShowStats(true);
      loadStats();
    }
  };

  const getStatForContainer = (c: Container): ContainerStat | undefined => {
    const id = getId(c);
    const name = getContainerName(c);
    return statsMap.get(id) || statsMap.get(name);
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
          <p style={{ color: 'var(--c-red)' }}>No container runtime detected.</p>
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
          <span style={S.muted}>Service: <strong style={{ color: 'var(--text-1)' }}>{service.service}</strong></span>
          <span style={{
            ...S.stateBadge,
            background: service.active === 'active' ? 'color-mix(in srgb, var(--c-green) 13%, transparent)' : 'color-mix(in srgb, var(--c-red) 13%, transparent)',
            color: service.active === 'active' ? 'var(--c-green)' : 'var(--c-red)',
          }}>{service.active}</span>
          <span style={{ ...S.stateBadge, background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)', color: 'var(--c-blue)' }}>{service.enabled}</span>
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
            style={{ ...S.passwordInput, borderColor: password ? 'var(--c-blue)' : 'var(--c-green)' }}
          />
          <button
            onClick={confirmAction}
            disabled={!password}
            style={{ ...S.confirmBtn, opacity: password ? 1 : 0.4, cursor: password ? 'pointer' : 'default' }}
          >
            Confirm
          </button>
          <button onClick={cancelAction} style={S.cancelBtn}>Cancel</button>
        </div>
      )}

      {/* Ownership info banner */}
      <div style={S.infoBanner}>
        {su.active
          ? 'Showing user and root resources. Owner column indicates who owns each item.'
          : 'Showing your resources only. Enable Administrative Access to see root resources.'}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {(['containers', 'images', 'volumes', 'networks', 'create'] as Tab[]).map((t) => (
          <button key={t} onClick={() => changeTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t === 'create' ? '+ New Container' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {tab === 'containers' && (
          <button style={{ ...S.btn, marginRight: '0.25rem', ...(showStats ? { background: 'color-mix(in srgb, var(--c-blue) 20%, transparent)', color: 'var(--c-blue)', borderColor: 'var(--c-blue)' } : {}) }}
            onClick={handleShowStats} disabled={statsLoading}>
            {statsLoading ? 'Loading…' : showStats ? '📊 Hide Stats' : '📊 Stats'}
          </button>
        )}
        <button style={S.btn} onClick={() => {
          refresh();
          if (tab === 'volumes') refreshVolumes();
          if (tab === 'networks') refreshNetworks();
        }} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── Containers tab ── */}
      {tab === 'containers' && (
        <div style={S.card}>
          <div style={S.searchRow}>
            <input
              style={{ ...S.searchInput, borderColor: ctrSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
              placeholder="Search containers by name…"
              value={ctrSearch}
              onChange={(e) => setCtrSearch(e.target.value)}
            />
            {ctrSearch && (
              <button style={S.searchClear} onClick={() => setCtrSearch('')}>✕</button>
            )}
            <span style={S.searchCount}>{sortedContainers.length}/{containers.length}</span>
            <button style={{ ...S.btn, marginLeft: 'auto' }}
              onClick={() => requestPrivileged('container_prune', 'Prune stopped containers')}>
              🗑 Prune Stopped
            </button>
          </div>
          {sortedContainers.length === 0 ? (
            <p style={S.muted}>{ctrSearch ? 'No containers match the filter.' : 'No containers found.'}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
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
                    {showStats ? (
                      <>
                        <th style={S.th}>CPU%</th>
                        <th style={S.th}>Memory</th>
                        <th style={S.th}>Net I/O</th>
                      </>
                    ) : (
                      <th style={S.th}>Status</th>
                    )}
                    <th style={S.th}>ID</th>
                    <th style={S.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedContainers.map((c) => {
                    const id = getId(c);
                    const state = (c.State || '').toLowerCase();
                    const owner = c._owner || 'user';
                    const stat = showStats ? getStatForContainer(c) : undefined;
                    return (
                      <tr key={id + owner} style={S.tr}>
                        <td style={S.td}><strong>{getContainerName(c)}</strong></td>
                        <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{c.Image}</td>
                        <td style={S.td}>
                          <span style={{ ...S.stateBadge, background: stateColor(c.State) }}>
                            {c.State}
                          </span>
                        </td>
                        <td style={S.td}>
                          <span style={{ ...S.stateBadge, background: ownerColor(owner) }}>
                            {owner}
                          </span>
                        </td>
                        {showStats ? (
                          <>
                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>
                              {statsLoading ? <span style={S.muted}>…</span> : (stat?.CPUPerc ?? <span style={S.muted}>—</span>)}
                            </td>
                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>
                              {statsLoading ? <span style={S.muted}>…</span> : (stat?.MemUsage ?? <span style={S.muted}>—</span>)}
                            </td>
                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>
                              {statsLoading ? <span style={S.muted}>…</span> : (stat?.NetIO ?? <span style={S.muted}>—</span>)}
                            </td>
                          </>
                        ) : (
                          <td style={{ ...S.td, fontSize: '0.8rem', color: 'var(--text-2)' }}>{c.Status}</td>
                        )}
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{id}</td>
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
                              sendAction('logs', { id, tail: logsTail, owner });
                              setLogs({ id, owner, text: '…' });
                            }} title="Logs">📋</button>
                            {confirmingRemove === `ctr:${id}:${owner}` ? (
                              <span style={S.confirmInline}>
                                <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                                <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => {
                                  setConfirmingRemove(null);
                                  requestPrivileged('remove', `Remove ${getContainerName(c)}`, id, { force: true, owner });
                                }}>Yes</button>
                                <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                              </span>
                            ) : (
                              <button style={{ ...S.actBtn, color: 'var(--c-red)' }} onClick={() => setConfirmingRemove(`ctr:${id}:${owner}`)} title="Remove">✕</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Images tab ── */}
      {tab === 'images' && (
        <div>
          <div style={{ ...S.card, marginBottom: '1rem' }}>
            <div style={S.pullRow}>
              <input
                style={{ ...S.input, borderColor: pullImage ? 'var(--c-blue)' : 'var(--c-green)' }}
                placeholder="Image name (e.g. nginx:latest)"
                value={pullImage}
                onChange={(e) => setPullImage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePull()}
                disabled={pulling !== null}
              />
              <button style={S.btn} onClick={handlePull} disabled={loading || !pullImage.trim() || pulling !== null}>
                {pulling ? 'Pulling...' : 'Pull Image'}
              </button>
              <button style={{ ...S.btn, marginLeft: '0.5rem' }}
                onClick={() => requestPrivileged('image_prune', 'Remove dangling images')}>
                🗑 Prune Dangling
              </button>
              <button style={{ ...S.btn, color: 'var(--c-red)', borderColor: 'color-mix(in srgb, var(--c-red) 40%, transparent)' }}
                onClick={() => requestPrivileged('system_prune', 'System prune (all unused resources)')}>
                ⚠ System Prune
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
            <div style={S.searchRow}>
              <input
                style={{ ...S.searchInput, borderColor: imgSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
                placeholder="Search images…"
                value={imgSearch}
                onChange={(e) => setImgSearch(e.target.value)}
              />
              {imgSearch && <button style={S.searchClear} onClick={() => setImgSearch('')}>✕</button>}
              <span style={S.searchCount}>{sortedImages.length}/{images.length}</span>
            </div>
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
                          <span style={{ ...S.stateBadge, background: ownerColor(owner) }}>
                            {owner}
                          </span>
                        </td>
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{id}</td>
                        <td style={S.td}>{formatSize(img.Size)}</td>
                        <td style={S.td}>
                          {confirmingRemove === `img:${id}:${owner}` ? (
                            <span style={S.confirmInline}>
                              <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                              <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => {
                                setConfirmingRemove(null);
                                requestPrivileged('remove_image', `Remove image ${getImageName(img)}`, id, { force: true, owner });
                              }}>Yes</button>
                              <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                            </span>
                          ) : (
                            <button style={{ ...S.actBtn, color: 'var(--c-red)' }} onClick={() => setConfirmingRemove(`img:${id}:${owner}`)} title="Remove">✕</button>
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

      {/* ── Volumes tab ── */}
      {tab === 'volumes' && (
        <div style={S.card}>
          <div style={S.searchRow}>
            <input
              style={{ ...S.searchInput, borderColor: volSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
              placeholder="Search volumes by name…"
              value={volSearch}
              onChange={(e) => setVolSearch(e.target.value)}
            />
            {volSearch && <button style={S.searchClear} onClick={() => setVolSearch('')}>✕</button>}
            <span style={S.searchCount}>{filteredVolumes.length}/{volumes.length}</span>
            <button style={S.btn} onClick={refreshVolumes} disabled={loading} title="Refresh volumes">↻</button>
            <button style={{ ...S.btn, marginLeft: '0.25rem' }}
              onClick={() => requestPrivileged('volume_prune', 'Remove unused volumes')}>
              🗑 Prune Unused
            </button>
          </div>
          {volumes.length === 0 ? (
            <p style={S.muted}>No volumes found. Click ↻ to load.</p>
          ) : filteredVolumes.length === 0 ? (
            <p style={S.muted}>No volumes match the filter.</p>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Driver</th>
                  <th style={S.th}>Owner</th>
                  <th style={S.th}>Scope</th>
                  <th style={S.th}>Mountpoint</th>
                  <th style={S.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredVolumes.map((v) => {
                  const name = v.Name || '—';
                  const owner = v._owner || 'user';
                  const key = `vol:${name}:${owner}`;
                  return (
                    <tr key={key} style={S.tr}>
                      <td style={S.td}><strong>{name}</strong></td>
                      <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{v.Driver || '—'}</td>
                      <td style={S.td}>
                        <span style={{ ...S.stateBadge, background: ownerColor(owner) }}>
                          {owner}
                        </span>
                      </td>
                      <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{v.Scope || '—'}</td>
                      <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-2)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={getVolumeMountpoint(v)}>
                        {getVolumeMountpoint(v)}
                      </td>
                      <td style={S.td}>
                        {confirmingRemove === key ? (
                          <span style={S.confirmInline}>
                            <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                            <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => {
                              setConfirmingRemove(null);
                              if (su.active) {
                                sendAction('volume_remove', { name, owner });
                              } else {
                                setPendingAction({ action: 'volume_remove', label: `Remove volume ${name}`, extra: { name, owner } });
                                setPassword('');
                                setError(null);
                              }
                            }}>Yes</button>
                            <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                          </span>
                        ) : (
                          <button style={{ ...S.actBtn, color: 'var(--c-red)' }} onClick={() => setConfirmingRemove(key)} title="Remove">✕</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Networks tab ── */}
      {tab === 'networks' && (
        <div style={S.card}>
          <div style={S.searchRow}>
            <input
              style={{ ...S.searchInput, borderColor: netSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
              placeholder="Search networks by name…"
              value={netSearch}
              onChange={(e) => setNetSearch(e.target.value)}
            />
            {netSearch && <button style={S.searchClear} onClick={() => setNetSearch('')}>✕</button>}
            <span style={S.searchCount}>{filteredNetworks.length}/{networks.length}</span>
            <button style={S.btn} onClick={refreshNetworks} disabled={loading} title="Refresh networks">↻</button>
          </div>
          {networks.length === 0 ? (
            <p style={S.muted}>No networks found. Click ↻ to load.</p>
          ) : filteredNetworks.length === 0 ? (
            <p style={S.muted}>No networks match the filter.</p>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Driver</th>
                  <th style={S.th}>Owner</th>
                  <th style={S.th}>Scope</th>
                  <th style={S.th}>ID</th>
                  <th style={S.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredNetworks.map((n) => {
                  const netName = getNetworkName(n);
                  const netId = getNetworkId(n);
                  const owner = n._owner || 'user';
                  const key = `net:${netId}:${owner}`;
                  // Built-in Docker/Podman networks — disable remove
                  const isBuiltin = ['bridge', 'host', 'none', 'podman'].includes(netName);
                  return (
                    <tr key={key} style={S.tr}>
                      <td style={S.td}><strong>{netName}</strong></td>
                      <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{getNetworkDriver(n)}</td>
                      <td style={S.td}>
                        <span style={{ ...S.stateBadge, background: ownerColor(owner) }}>
                          {owner}
                        </span>
                      </td>
                      <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{getNetworkScope(n)}</td>
                      <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{netId}</td>
                      <td style={S.td}>
                        {isBuiltin ? (
                          <span style={{ ...S.muted, fontSize: '0.75rem' }}>built-in</span>
                        ) : confirmingRemove === key ? (
                          <span style={S.confirmInline}>
                            <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                            <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => {
                              setConfirmingRemove(null);
                              if (su.active) {
                                sendAction('network_remove', { id: netName, owner });
                              } else {
                                setPendingAction({ action: 'network_remove', label: `Remove network ${netName}`, extra: { id: netName, owner } });
                                setPassword('');
                                setError(null);
                              }
                            }}>Yes</button>
                            <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                          </span>
                        ) : (
                          <button style={{ ...S.actBtn, color: 'var(--c-red)' }} onClick={() => setConfirmingRemove(key)} title="Remove">✕</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Create tab ── */}
      {tab === 'create' && (
        <div style={S.card}>
          <h3 style={S.formTitle}>Create New Container</h3>
          <div style={S.formGrid}>
            <label style={S.label}>Image *
              <input style={{ ...S.input, borderColor: form.image ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="nginx:latest" value={form.image}
                onChange={(e) => setForm({ ...form, image: e.target.value })} />
            </label>
            <label style={S.label}>Name
              <input style={{ ...S.input, borderColor: form.name ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="my-container" value={form.name}
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
                <input style={{ ...S.inputSm, borderColor: p.host ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="Host port" value={p.host}
                  onChange={(e) => { const ports = [...form.ports]; ports[i] = { ...p, host: e.target.value }; setForm({ ...form, ports }); }} />
                <span style={S.muted}>→</span>
                <input style={{ ...S.inputSm, borderColor: p.container ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="Container port" value={p.container}
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
                <input style={{ ...S.inputSm, borderColor: e.key ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="KEY" value={e.key}
                  onChange={(ev) => { const env = [...form.env]; env[i] = { ...e, key: ev.target.value }; setForm({ ...form, env }); }} />
                <span style={S.muted}>=</span>
                <input style={{ ...S.inputSm, borderColor: e.value ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="value" value={e.value}
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
                <input style={{ ...S.inputSm, borderColor: v.host ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="Host path" value={v.host}
                  onChange={(e) => { const vols = [...form.volumes]; vols[i] = { ...v, host: e.target.value }; setForm({ ...form, volumes: vols }); }} />
                <span style={S.muted}>→</span>
                <input style={{ ...S.inputSm, borderColor: v.container ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="Container path" value={v.container}
                  onChange={(e) => { const vols = [...form.volumes]; vols[i] = { ...v, container: e.target.value }; setForm({ ...form, volumes: vols }); }} />
                {form.volumes.length > 1 && (
                  <button style={S.rmBtn} onClick={() => {
                    const vols = form.volumes.filter((_, j) => j !== i); setForm({ ...form, volumes: vols });
                  }}>✕</button>
                )}
              </div>
            ))}
          </div>

          <div style={S.formGrid}>
            <label style={S.label}>Restart Policy
              <select style={{ ...S.input, borderColor: form.restart ? 'var(--c-blue)' : 'var(--c-green)' }} value={form.restart}
                onChange={(e) => setForm({ ...form, restart: e.target.value })}>
                <option value="">None</option>
                <option value="always">Always</option>
                <option value="unless-stopped">Unless Stopped</option>
                <option value="on-failure">On Failure</option>
              </select>
            </label>
            <label style={S.label}>Command (optional)
              <input style={{ ...S.input, borderColor: form.command ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="e.g. /bin/sh -c 'echo hello'" value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })} />
            </label>
          </div>

          <button style={{ ...S.btn, marginTop: '1rem', padding: '0.6rem 2rem' }}
            onClick={handleCreate} disabled={!form.image || loading}>
            Create & Start
          </button>
        </div>
      )}

      {/* ── Logs modal ── */}
      {logs && (
        <div style={S.overlay} onClick={() => setLogs(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Logs: {logs.id}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ ...S.muted, fontSize: '0.75rem' }}>Lines:</span>
                <select style={{ ...S.inputSm, width: 80, flex: 'none' }} value={logsTail}
                  onChange={(e) => setLogsTail(Number(e.target.value))}>
                  <option value={50}>50</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                  <option value={0}>All</option>
                </select>
                <button style={S.actBtn} title="Reload with selected line count" onClick={() => {
                  if (logs) sendAction('logs', { id: logs.id, tail: logsTail, owner: logs.owner });
                }}>↻</button>
                <button style={S.actBtn} onClick={() => setLogs(null)}>✕</button>
              </div>
            </div>
            <pre ref={logsPreRef} style={S.logsPre}>{stripAnsi(logs.text) || '(empty)'}</pre>
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
    background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)',
    color: 'var(--c-blue)',
    padding: '0.2rem 0.6rem',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  muted: {
    color: 'var(--text-2)',
    fontSize: '0.85rem',
  },
  card: {
    background: 'var(--bg-panel)',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
  },
  error: {
    background: 'color-mix(in srgb, var(--c-red) 13%, transparent)',
    border: '1px solid color-mix(in srgb, var(--c-red) 27%, transparent)',
    borderRadius: 6,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    color: 'var(--c-red)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '0.85rem',
  },
  errorClose: {
    background: 'none',
    border: 'none',
    color: 'var(--c-red)',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  serviceBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    background: 'var(--bg-panel)',
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
    color: 'var(--badge-fg)',
  },
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    marginBottom: '1rem',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  tab: {
    padding: '0.45rem 1rem',
    borderRadius: '6px 6px 0 0',
    border: 'none',
    background: 'var(--bg-panel)',
    color: 'var(--text-2)',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  tabActive: {
    background: 'var(--c-blue)',
    color: 'var(--bg-app)',
  },
  btn: {
    padding: '0.35rem 0.75rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-panel)',
    color: 'var(--text-1)',
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
    color: 'var(--text-2)',
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap' as const,
  },
  thSort: {
    textAlign: 'left' as const,
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-2)',
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
  },
  tr: {
    borderBottom: '1px solid var(--bg-surface)',
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
    color: 'var(--text-1)',
    cursor: 'pointer',
    padding: '0.2rem 0.4rem',
    fontSize: '0.8rem',
  },
  pullRow: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
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
    color: 'var(--text-2)',
  },
  input: {
    padding: '0.4rem 0.6rem',
    borderRadius: 4,
    border: '1px solid var(--c-green)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    outline: 'none',
  },
  inputSm: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid var(--c-green)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
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
    color: 'var(--text-2)',
    fontWeight: 600,
  },
  addBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--c-blue)',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
  },
  rmBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--c-red)',
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
    background: 'var(--bg-panel)',
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
    background: 'var(--bg-surface)',
    borderRadius: 6,
    padding: '0.75rem',
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    overflow: 'auto',
    flex: 1,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    maxHeight: '60vh',
    color: 'var(--text-1)',
  },
  passwordBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    background: 'var(--bg-panel)',
    borderRadius: 8,
    padding: '0.5rem 1rem',
    marginBottom: '1rem',
    flexWrap: 'wrap' as const,
  },
  passwordLabel: {
    fontSize: '0.8rem',
    color: 'var(--text-2)',
    whiteSpace: 'nowrap' as const,
  },
  passwordInput: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid var(--c-green)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    width: 200,
  },
  confirmBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid color-mix(in srgb, var(--c-green) 40%, transparent)',
    background: 'color-mix(in srgb, var(--c-green) 13%, transparent)',
    color: 'var(--c-green)',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '0.3rem 0.7rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontSize: '0.8rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  infoBanner: {
    background: 'color-mix(in srgb, var(--c-blue) 7%, transparent)',
    border: '1px solid color-mix(in srgb, var(--c-blue) 20%, transparent)',
    borderRadius: 6,
    padding: '0.4rem 0.75rem',
    marginBottom: '0.75rem',
    color: 'var(--c-blue)',
    fontSize: '0.8rem',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  searchInput: {
    padding: '0.4rem 0.6rem',
    borderRadius: 4,
    border: '1px solid var(--c-green)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    outline: 'none',
    flex: 1,
    minWidth: 160,
  },
  searchClear: {
    background: 'none',
    border: 'none',
    color: 'var(--text-2)',
    cursor: 'pointer',
    fontSize: '0.9rem',
    padding: '0 0.2rem',
  },
  searchCount: {
    color: 'var(--text-2)',
    fontSize: '0.75rem',
    whiteSpace: 'nowrap' as const,
  },
  confirmInline: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
  },
  progressWrap: {
    padding: '0.75rem 0 0.25rem',
  },
  progressLabel: {
    display: 'block',
    color: 'var(--text-2)',
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
    background: 'linear-gradient(90deg, transparent, var(--c-blue), transparent)',
    animation: 'progress-slide 1.2s ease-in-out infinite',
  },
};
