import { useEffect, useState, useCallback, useRef } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';
import { ContainerExec } from './ContainerExec.tsx';

/* ── types ─────────────────────────────────────────────── */

interface Container {
  Id?: string;
  ID?: string;
  Names?: string | string[];
  Name?: string;
  Image?: string;
  State?: string;
  Status?: string;
  _owner?: string;
}

interface ContainerImage {
  Id?: string;
  ID?: string;
  Repository?: string;
  RepoTags?: string[];
  Tag?: string;
  Size?: number;
  _owner?: string;
}

interface Volume {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  MountPoint?: string;
  Scope?: string;
  _owner?: string;
}

interface VolumeInspect {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  MountPoint?: string;
  CreatedAt?: string;
  Scope?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
}

interface Network {
  ID?: string; Id?: string; id?: string;
  Name?: string; name?: string;
  Driver?: string; driver?: string;
  Scope?: string; scope?: string;
  _owner?: string;
}

interface NetworkInspect {
  // Docker (capitalized)
  Name?: string; Id?: string; Driver?: string; Scope?: string;
  Internal?: boolean; EnableIPv6?: boolean;
  IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
  Containers?: Record<string, { Name?: string; IPv4Address?: string; IPv6Address?: string }>;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
  // Podman (lowercase)
  name?: string; id?: string; driver?: string; scope?: string;
  internal?: boolean; ipv6_enabled?: boolean;
  subnets?: Array<{ subnet?: string; gateway?: string }>;
  containers?: Record<string, { name?: string; container_id?: string }>;
  labels?: Record<string, string> | null;
  options?: Record<string, string> | null;
  dns_enabled?: boolean;
}

interface ContainerStat {
  ID?: string; Name?: string;
  CPUPerc?: string; MemUsage?: string; MemPerc?: string;
  NetIO?: string; BlockIO?: string;
}

interface ServiceStatus { service: string; active: string; enabled: string; }

type Tab = 'containers' | 'images' | 'volumes' | 'networks' | 'create';
type SortDir = 'asc' | 'desc' | null;

/* ── constants ─────────────────────────────────────────── */

const CTR_STATE_ORDER: Record<string, number> = { running: 0, paused: 1, restarting: 2, created: 3, exited: 4, dead: 5 };
const OWNER_ORDER: Record<string, number> = { user: 0, root: 1 };
const BUILTIN_NETS = new Set(['bridge', 'host', 'none', 'podman']);
const NET_DRIVERS = ['bridge', 'overlay', 'macvlan', 'ipvlan', 'null'];

/* ── helpers ───────────────────────────────────────────── */

function nextDir(d: SortDir): SortDir { return d === null ? 'desc' : d === 'desc' ? 'asc' : null; }
function sortArrow(d: SortDir): string { return d === 'desc' ? ' ▼' : d === 'asc' ? ' ▲' : ''; }

function friendlyError(action: string, raw: string): string {
  const lo = raw.toLowerCase();
  if (lo.includes('image is being used by running container')) {
    const m = raw.match(/running container ([a-f0-9]+)/i);
    return `Cannot remove image — in use by running container${m ? ` (${m[1].slice(0, 12)})` : ''}. Stop it first.`;
  }
  if (lo.includes('image is being used') || lo.includes('dependent child')) return 'Cannot remove image — in use. Remove dependent containers first.';
  if (lo.includes('is already in progress')) return 'Operation already in progress.';
  if (lo.includes('no such container')) return 'Container not found — may already be removed.';
  if (lo.includes('no such image')) return 'Image not found — may already be removed.';
  if (lo.includes('pre-defined network') || lo.includes('predefined network')) return 'Cannot remove built-in network.';
  if (lo.includes('network') && lo.includes('active endpoints')) return 'Cannot remove network — has active endpoints. Disconnect containers first.';
  if (lo.includes('volume is in use')) return 'Cannot remove volume — in use by a container.';
  if (lo.includes('authentication failed') || lo.includes('incorrect password')) return 'Authentication failed — check your password.';
  return `${action}: ${raw}`;
}

function getId(c: Container | ContainerImage): string { return (c.Id || c.ID || '').slice(0, 12); }

interface ContainerInspect {
  Id?: string;
  Name?: string;
  Created?: string;
  Config?: { Image?: string; Cmd?: string[] | null; Entrypoint?: string[] | null; Env?: string[] | null; WorkingDir?: string };
  State?: { Status?: string; Running?: boolean; Health?: { Status?: string } };
  HostConfig?: { RestartPolicy?: { Name?: string } };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean; Name?: string }>;
  NetworkSettings?: {
    IPAddress?: string;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
    Networks?: Record<string, { IPAddress?: string }> | null;
  };
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
  if (img.RepoTags?.length) return img.RepoTags[0];
  if (img.Repository) return `${img.Repository}:${img.Tag || 'latest'}`;
  return getId(img);
}

function getNetId(n: Network): string { return (n.ID || n.Id || n.id || '').slice(0, 12); }
function getNetName(n: Network): string { return n.Name || n.name || getNetId(n); }
function getNetDriver(n: Network): string { return n.Driver || n.driver || '—'; }
function getNetScope(n: Network): string { return n.Scope || n.scope || '—'; }
function getVolMount(v: Volume | VolumeInspect): string { return v.Mountpoint || v.MountPoint || '—'; }

function niName(n: NetworkInspect): string { return n.Name || n.name || '—'; }
function niDriver(n: NetworkInspect): string { return n.Driver || n.driver || '—'; }
function niScope(n: NetworkInspect): string { return n.Scope || n.scope || '—'; }
function niInternal(n: NetworkInspect): boolean { return !!(n.Internal || n.internal); }
function niIPv6(n: NetworkInspect): boolean { return !!(n.EnableIPv6 || n.ipv6_enabled); }

function niSubnets(n: NetworkInspect): Array<{ subnet: string; gateway: string }> {
  if (n.IPAM?.Config?.length) return n.IPAM.Config.map(c => ({ subnet: c.Subnet || '—', gateway: c.Gateway || '—' }));
  if (n.subnets?.length) return n.subnets.map(s => ({ subnet: s.subnet || '—', gateway: s.gateway || '—' }));
  return [];
}

function niContainers(n: NetworkInspect): Array<{ id: string; name: string; ip: string }> {
  if (n.Containers) {
    return Object.entries(n.Containers).map(([id, c]) => ({ id: id.slice(0, 12), name: c.Name || id.slice(0, 12), ip: c.IPv4Address || '—' }));
  }
  if (n.containers) {
    return Object.entries(n.containers).map(([id, c]) => ({ id: id.slice(0, 12), name: c.name || id.slice(0, 12), ip: '—' }));
  }
  return [];
}

function renderKV(obj: Record<string, string> | null | undefined): string {
  if (!obj) return '—';
  const entries = Object.entries(obj);
  if (!entries.length) return '—';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
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

function stateColor(s?: string): string {
  const v = (s || '').toLowerCase();
  if (v === 'running') return 'var(--c-green)';
  if (v === 'exited' || v === 'dead') return 'var(--c-red)';
  if (v === 'paused') return 'var(--c-yellow)';
  if (v === 'created' || v === 'restarting') return 'var(--c-blue)';
  return 'var(--text-3)';
}

function ownerColor(o?: string): string { return o === 'root' ? 'var(--c-green)' : 'var(--c-yellow)'; }

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[mGKHFJA-Za-z]/g, '');
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
  const [tab, changeTab] = useTabParam<Tab>(['containers', 'images', 'volumes', 'networks', 'create'], 'containers');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: string; id?: string; label: string; extra?: Record<string, unknown> } | null>(null);
  const [password, setPassword] = useState('');
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  // Logs
  const [logs, setLogs] = useState<{ id: string; owner: string; text: string } | null>(null);
  const [logsTail, setLogsTail] = useState(200);
  const logsPreRef = useRef<HTMLPreElement | null>(null);

  // Exec (interactive shell into a container)
  const [execTarget, setExecTarget] = useState<{ id: string; name: string } | null>(null);

  // Stats
  const [statsMap, setStatsMap] = useState<Map<string, ContainerStat>>(new Map());
  const [statsLoading, setStatsLoading] = useState(false);
  const [showStats, setShowStats] = useState(false);

  // Inspect modals
  const [netInspect, setNetInspect] = useState<NetworkInspect | null>(null);
  const [volInspect, setVolInspect] = useState<VolumeInspect | null>(null);
  const [ctrInspect, setCtrInspect] = useState<ContainerInspect | null>(null);
  const netInspectRef = useRef<NetworkInspect | null>(null);
  netInspectRef.current = netInspect;

  // Create forms
  const [showCreateNet, setShowCreateNet] = useState(false);
  const [showCreateVol, setShowCreateVol] = useState(false);
  const [netForm, setNetForm] = useState({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, ipv6: false });
  const [volForm, setVolForm] = useState({ name: '', driver: '', labels: [{ key: '', value: '' }] });

  // Connect container in network inspect
  const [connectCtr, setConnectCtr] = useState('');

  // Image pull
  const [pullImage, setPullImage] = useState('');
  const [pulling, setPulling] = useState<string | null>(null);

  // Create container form
  const [form, setForm] = useState({
    image: '', name: '',
    ports: [{ host: '', container: '' }],
    env: [{ key: '', value: '' }],
    volumes: [{ host: '', container: '' }],
    restart: '', command: '',
  });

  // Inline remove confirmation
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  // Search
  const [ctrSearch, setCtrSearch] = useState('');
  const [imgSearch, setImgSearch] = useState('');
  const [volSearch, setVolSearch] = useState('');
  const [netSearch, setNetSearch] = useState('');

  // Sorting
  const [ctrSortCol, setCtrSortCol] = useState<'name' | 'state' | 'owner' | null>(null);
  const [ctrSortDir, setCtrSortDir] = useState<SortDir>(null);
  const [imgSortCol, setImgSortCol] = useState<'owner' | null>(null);
  const [imgSortDir, setImgSortDir] = useState<SortDir>(null);

  const handleCtrSort = (col: 'name' | 'state' | 'owner') => {
    if (ctrSortCol === col) { const nd = nextDir(ctrSortDir); setCtrSortDir(nd); if (nd === null) setCtrSortCol(null); }
    else { setCtrSortCol(col); setCtrSortDir('desc'); }
  };
  const handleImgSort = (col: 'owner') => {
    if (imgSortCol === col) { const nd = nextDir(imgSortDir); setImgSortDir(nd); if (nd === null) setImgSortCol(null); }
    else { setImgSortCol(col); setImgSortDir('desc'); }
  };

  const sortedContainers = (() => {
    const needle = ctrSearch.toLowerCase();
    const filtered = needle ? containers.filter(c => getContainerName(c).toLowerCase().includes(needle)) : containers;
    if (!ctrSortCol || !ctrSortDir) return filtered;
    const mul = ctrSortDir === 'desc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (ctrSortCol === 'name') return mul * getContainerName(a).localeCompare(getContainerName(b));
      if (ctrSortCol === 'state') return mul * ((CTR_STATE_ORDER[(a.State || '').toLowerCase()] ?? 99) - (CTR_STATE_ORDER[(b.State || '').toLowerCase()] ?? 99));
      return mul * ((OWNER_ORDER[a._owner || 'user'] ?? 99) - (OWNER_ORDER[b._owner || 'user'] ?? 99));
    });
  })();

  const sortedImages = (() => {
    const needle = imgSearch.toLowerCase();
    const filtered = needle ? images.filter(img => getImageName(img).toLowerCase().includes(needle)) : images;
    if (!imgSortCol || !imgSortDir) return filtered;
    const mul = imgSortDir === 'desc' ? 1 : -1;
    return [...filtered].sort((a, b) => mul * ((OWNER_ORDER[a._owner || 'user'] ?? 99) - (OWNER_ORDER[b._owner || 'user'] ?? 99)));
  })();

  const filteredVols = volSearch ? volumes.filter(v => (v.Name || '').toLowerCase().includes(volSearch.toLowerCase())) : volumes;
  const filteredNets = netSearch ? networks.filter(n => getNetName(n).toLowerCase().includes(netSearch.toLowerCase())) : networks;

  const suRef = useRef(su);
  suRef.current = su;

  const sendAction = useCallback((action: string, extra: Record<string, unknown> = {}) => {
    const payload: Record<string, unknown> = { action, ...extra };
    const s = suRef.current;
    if (s.active && s.password && !('password' in extra)) payload.password = s.password;
    channelRef.current?.send(payload);
  }, []);

  const refresh = useCallback(() => { sendAction('list_containers'); sendAction('list_images'); sendAction('service_status'); }, [sendAction]);
  const refreshVolumes = useCallback(() => sendAction('volumes_list'), [sendAction]);
  const refreshNetworks = useCallback(() => sendAction('networks_list'), [sendAction]);
  const loadStats = useCallback(() => { setStatsLoading(true); sendAction('stats_all'); }, [sendAction]);

  useEffect(() => {
    setRuntime(null); setAvailable(null);
    setContainers([]); setImages([]); setVolumes([]); setNetworks([]);
    setService(null); setError(null); setLogs(null); setPulling(null);
    setCtrSearch(''); setImgSearch(''); setVolSearch(''); setNetSearch('');
    setConfirmingRemove(null); setStatsMap(new Map()); setShowStats(false);
    setNetInspect(null); setVolInspect(null); setCtrInspect(null);

    const ch = openChannel('container.manage');
    channelRef.current = ch;

    ch.onMessage((msg: Message) => {
      if (msg.type !== 'data' || !('data' in msg)) return;
      const d = msg.data as Record<string, unknown>;

      if (d.type === 'init') {
        setRuntime(d.runtime as string | null);
        const info = d.info as Record<string, unknown>;
        setAvailable(!!info?.available);
        if (info?.service) setService(info.service as ServiceStatus);
        if (info?.available) { sendAction('list_containers'); sendAction('list_images'); }
        return;
      }

      if (d.type === 'response') {
        setLoading(false);
        const action = d.action as string;
        const data = d.data as Record<string, unknown>;

        if (action === 'list_containers') {
          if (Array.isArray(data)) setContainers(data as Container[]);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'list_images') {
          if (Array.isArray(data)) setImages(data as ContainerImage[]);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'volumes_list') {
          if (Array.isArray(data)) setVolumes(data as Volume[]);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'networks_list') {
          if (Array.isArray(data)) setNetworks(data as Network[]);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'volume_inspect') {
          if (Array.isArray(data) && data.length > 0) setVolInspect(data[0] as VolumeInspect);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'network_inspect') {
          if (Array.isArray(data) && data.length > 0) setNetInspect(data[0] as NetworkInspect);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'inspect') {
          if (Array.isArray(data) && data.length > 0) setCtrInspect(data[0] as ContainerInspect);
          else if (data?.error) setError(String(data.error));
        } else if (action === 'stats_all') {
          setStatsLoading(false);
          if (Array.isArray(data)) {
            const m = new Map<string, ContainerStat>();
            for (const s of data as ContainerStat[]) {
              const id = (s.ID || '').slice(0, 12);
              const name = (s.Name || '').replace(/^\//, '');
              if (id) m.set(id, s);
              if (name) m.set(name, s);
            }
            setStatsMap(m);
          } else if (data?.error) { setStatsLoading(false); setError(String(data.error)); }
        } else if (action === 'logs') {
          if (data?.logs != null) setLogs(prev => ({ id: String(data.id || ''), owner: prev?.owner || 'user', text: String(data.logs) }));
        } else if (action === 'service_status') {
          setService(data as unknown as ServiceStatus);
        } else if (['start', 'stop', 'restart', 'remove', 'remove_image', 'pull', 'create'].includes(action)) {
          if (action === 'pull') setPulling(null);
          if (data?.error) setError(friendlyError(action, String(data.error)));
          setTimeout(() => refresh(), 150);
        } else if (['volume_create', 'volume_remove', 'volume_prune'].includes(action)) {
          if (data?.error) setError(friendlyError(action, String(data.error)));
          else if (action === 'volume_create') { setShowCreateVol(false); setVolForm({ name: '', driver: '', labels: [{ key: '', value: '' }] }); }
          setTimeout(() => refreshVolumes(), 150);
        } else if (['network_create', 'network_remove', 'network_prune'].includes(action)) {
          if (data?.error) setError(friendlyError(action, String(data.error)));
          else if (action === 'network_create') { setShowCreateNet(false); setNetForm({ name: '', driver: 'bridge', subnet: '', gateway: '', internal: false, ipv6: false }); }
          setTimeout(() => refreshNetworks(), 150);
        } else if (['network_connect', 'network_disconnect'].includes(action)) {
          if (data?.error) setError(friendlyError(action, String(data.error)));
          else {
            setConnectCtr('');
            // Re-inspect to refresh connected containers
            const cur = netInspectRef.current;
            if (cur) sendAction('network_inspect', { id: niName(cur) });
          }
          setTimeout(() => refreshNetworks(), 300);
        } else if (['container_prune', 'image_prune', 'system_prune'].includes(action)) {
          if (data?.error) setError(friendlyError(action, String(data.error)));
          setTimeout(() => refresh(), 150);
        } else if (['service_start', 'service_stop', 'service_restart'].includes(action)) {
          setTimeout(() => sendAction('service_status'), 150);
        }
      }

      if (d.type === 'error') {
        setError(String(d.error));
        setLoading(false); setPulling(null); setStatsLoading(false);
      }
    });

    return () => ch.close();
  }, [openChannel, refresh, refreshVolumes, refreshNetworks, sendAction]);

  // Lazy-load volumes/networks on first tab visit
  const prevTab = useRef<Tab>('containers');
  useEffect(() => {
    if (tab === prevTab.current || !available) return;
    prevTab.current = tab;
    if (tab === 'volumes') refreshVolumes();
    if (tab === 'networks') refreshNetworks();
  }, [tab, available, refreshVolumes, refreshNetworks]);

  // Re-fetch on superuser toggle
  const prevSuActive = useRef(su.active);
  useEffect(() => {
    if (su.active === prevSuActive.current) return;
    prevSuActive.current = su.active;
    if (!available) return;
    refresh();
    if (tab === 'volumes') refreshVolumes();
    if (tab === 'networks') refreshNetworks();
  }, [su.active, available, refresh, refreshVolumes, refreshNetworks, tab]);

  // Auto-scroll logs
  useEffect(() => {
    if (logs && logsPreRef.current) logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
  }, [logs]);

  const requestPrivileged = (action: string, label: string, id?: string, extra?: Record<string, unknown>) => {
    if (su.active) {
      setLoading(true); setError(null);
      const payload: Record<string, unknown> = { ...extra };
      if (id) payload.id = id;
      sendAction(action, payload);
      return;
    }
    setPendingAction({ action, id, label, extra });
    setPassword(''); setError(null);
  };

  const confirmAction = () => {
    if (!pendingAction || !password) return;
    setLoading(true); setError(null);
    const payload: Record<string, unknown> = { password, ...pendingAction.extra };
    if (pendingAction.id) payload.id = pendingAction.id;
    sendAction(pendingAction.action, payload);
    setPendingAction(null); setPassword('');
  };

  const cancelAction = () => { setPendingAction(null); setPassword(''); };

  const handleCreate = () => {
    requestPrivileged('create', 'Create container', undefined, {
      image: form.image, name: form.name,
      ports: form.ports.filter(p => p.host && p.container),
      env: form.env.filter(e => e.key),
      volumes: form.volumes.filter(v => v.host && v.container),
      restart: form.restart, command: form.command,
    });
    setForm({ image: '', name: '', ports: [{ host: '', container: '' }], env: [{ key: '', value: '' }], volumes: [{ host: '', container: '' }], restart: '', command: '' });
    changeTab('containers');
  };

  const handlePull = () => {
    if (!pullImage.trim()) return;
    const img = pullImage.trim(); setPulling(img);
    requestPrivileged('pull', `Pull ${img}`, undefined, { image: img });
    setPullImage('');
  };

  const handleShowStats = () => {
    if (showStats) { setShowStats(false); setStatsMap(new Map()); }
    else { setShowStats(true); loadStats(); }
  };

  const getStatFor = (c: Container): ContainerStat | undefined => {
    const id = getId(c); const name = getContainerName(c);
    return statsMap.get(id) || statsMap.get(name);
  };

  /* ── render ──────────────────────────────────────────── */

  if (available === null) return <div><PageHeader icon="containers" title="Containers" /><p style={S.muted}>Detecting container runtime…</p></div>;

  if (!available) return (
    <div><PageHeader icon="containers" title="Containers" />
      <div style={S.card}>
        <p style={{ color: 'var(--c-red)' }}>No container runtime detected.</p>
        <p style={S.muted}>Install <strong>podman</strong> or <strong>docker</strong> to manage containers.</p>
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        icon="containers"
        title="Containers"
        actions={<span style={S.runtimeBadge}>{runtime}</span>}
      />

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
          <span style={{ ...S.stateBadge, background: service.active === 'active' ? 'color-mix(in srgb, var(--c-green) 13%, transparent)' : 'color-mix(in srgb, var(--c-red) 13%, transparent)', color: service.active === 'active' ? 'var(--c-green)' : 'var(--c-red)' }}>{service.active}</span>
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
          <span style={S.passwordLabel}>Password required for <b>{pendingAction.label}</b>:</span>
          <input type="password" value={password} autoFocus
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmAction(); if (e.key === 'Escape') cancelAction(); }}
            placeholder="Enter password…"
            style={{ ...S.passwordInput, borderColor: password ? 'var(--c-blue)' : 'var(--c-green)' }} />
          <button onClick={confirmAction} disabled={!password} style={{ ...S.confirmBtn, opacity: password ? 1 : 0.4, cursor: password ? 'pointer' : 'default' }}>Confirm</button>
          <button onClick={cancelAction} style={S.cancelBtn}>Cancel</button>
        </div>
      )}

      <div style={S.infoBanner}>
        {su.active ? 'Showing user and root resources. Owner column indicates ownership.' : 'Showing your resources only. Enable Administrative Access to see root resources.'}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        <Tabs
          tabs={[
            { id: 'containers', label: 'Containers' },
            { id: 'images', label: 'Images' },
            { id: 'volumes', label: 'Volumes' },
            { id: 'networks', label: 'Networks' },
            { id: 'create', label: '+ New Container' },
          ]}
          active={tab}
          onChange={(t) => changeTab(t as Tab)}
        />
        <div style={{ flex: 1 }} />
        {tab === 'containers' && (
          <button style={{ ...S.btn, marginRight: '0.25rem', ...(showStats ? { background: 'color-mix(in srgb, var(--c-blue) 20%, transparent)', color: 'var(--c-blue)', borderColor: 'var(--c-blue)' } : {}) }}
            onClick={handleShowStats} disabled={statsLoading}>
            {statsLoading ? 'Loading…' : showStats ? '📊 Hide Stats' : '📊 Stats'}
          </button>
        )}
        <button style={S.btn} onClick={() => { refresh(); if (tab === 'volumes') refreshVolumes(); if (tab === 'networks') refreshNetworks(); }} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── Containers tab ── */}
      {tab === 'containers' && (
        <div style={S.card}>
          <div style={S.searchRow}>
            <input style={{ ...S.searchInput, borderColor: ctrSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
              placeholder="Search containers by name…" value={ctrSearch} onChange={e => setCtrSearch(e.target.value)} />
            {ctrSearch && <button style={S.searchClear} onClick={() => setCtrSearch('')}>✕</button>}
            <span style={S.searchCount}>{sortedContainers.length}/{containers.length}</span>
            <button style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => requestPrivileged('container_prune', 'Prune stopped containers')}>🗑 Prune Stopped</button>
          </div>
          {sortedContainers.length === 0 ? (
            <p style={S.muted}>{ctrSearch ? 'No containers match the filter.' : 'No containers found.'}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.thSort} onClick={() => handleCtrSort('name')}>Name{ctrSortCol === 'name' ? sortArrow(ctrSortDir) : ''}</th>
                    <th style={S.th}>Image</th>
                    <th style={S.thSort} onClick={() => handleCtrSort('state')}>State{ctrSortCol === 'state' ? sortArrow(ctrSortDir) : ''}</th>
                    <th style={S.thSort} onClick={() => handleCtrSort('owner')}>Owner{ctrSortCol === 'owner' ? sortArrow(ctrSortDir) : ''}</th>
                    {showStats ? (<><th style={S.th}>CPU%</th><th style={S.th}>Memory</th><th style={S.th}>Net I/O</th></>) : <th style={S.th}>Status</th>}
                    <th style={S.th}>ID</th>
                    <th style={S.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedContainers.map(c => {
                    const id = getId(c); const state = (c.State || '').toLowerCase(); const owner = c._owner || 'user';
                    const stat = showStats ? getStatFor(c) : undefined;
                    return (
                      <tr key={id + owner} style={S.tr}>
                        <td style={S.td}><strong>{getContainerName(c)}</strong></td>
                        <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{c.Image}</td>
                        <td style={S.td}><span style={{ ...S.stateBadge, background: stateColor(c.State) }}>{c.State}</span></td>
                        <td style={S.td}><span style={{ ...S.stateBadge, background: ownerColor(owner) }}>{owner}</span></td>
                        {showStats ? (
                          <>
                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>{statsLoading ? <span style={S.muted}>…</span> : (stat?.CPUPerc ?? <span style={S.muted}>—</span>)}</td>
                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>{statsLoading ? <span style={S.muted}>…</span> : (stat?.MemUsage ?? <span style={S.muted}>—</span>)}</td>
                            <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>{statsLoading ? <span style={S.muted}>…</span> : (stat?.NetIO ?? <span style={S.muted}>—</span>)}</td>
                          </>
                        ) : <td style={{ ...S.td, fontSize: '0.8rem', color: 'var(--text-2)' }}>{c.Status}</td>}
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{id}</td>
                        <td style={S.td}>
                          <div style={S.actions}>
                            {state !== 'running' && <button style={S.actBtn} onClick={() => requestPrivileged('start', `Start ${getContainerName(c)}`, id, { owner })} title="Start">▶</button>}
                            {state === 'running' && <button style={S.actBtn} onClick={() => requestPrivileged('stop', `Stop ${getContainerName(c)}`, id, { owner })} title="Stop">■</button>}
                            <button style={S.actBtn} onClick={() => requestPrivileged('restart', `Restart ${getContainerName(c)}`, id, { owner })} title="Restart">↻</button>
                            {state === 'running' && (
                              <button style={S.actBtn} title="Shell (exec)"
                                onClick={() => {
                                  if (!su.active) { setError('Enable superuser mode (top bar) to open a container shell.'); return; }
                                  setExecTarget({ id, name: getContainerName(c) });
                                }}>❯_</button>
                            )}
                            <button style={S.actBtn} onClick={() => sendAction('inspect', { id, owner })} title="Inspect">🔍</button>
                            <button style={S.actBtn} onClick={() => { sendAction('logs', { id, tail: logsTail, owner }); setLogs({ id, owner, text: '…' }); }} title="Logs">📋</button>
                            {confirmingRemove === `ctr:${id}:${owner}` ? (
                              <span style={S.confirmInline}>
                                <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                                <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => { setConfirmingRemove(null); requestPrivileged('remove', `Remove ${getContainerName(c)}`, id, { force: true, owner }); }}>Yes</button>
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
              <input style={{ ...S.input, borderColor: pullImage ? 'var(--c-blue)' : 'var(--c-green)' }}
                placeholder="Image name (e.g. nginx:latest)" value={pullImage} disabled={pulling !== null}
                onChange={e => setPullImage(e.target.value)} onKeyDown={e => e.key === 'Enter' && handlePull()} />
              <button style={S.btn} onClick={handlePull} disabled={loading || !pullImage.trim() || pulling !== null}>{pulling ? 'Pulling...' : 'Pull Image'}</button>
              <button style={{ ...S.btn, marginLeft: '0.5rem' }} onClick={() => requestPrivileged('image_prune', 'Remove dangling images')}>🗑 Prune Dangling</button>
              <button style={{ ...S.btn, color: 'var(--c-red)', borderColor: 'color-mix(in srgb, var(--c-red) 40%, transparent)' }} onClick={() => requestPrivileged('system_prune', 'System prune — all unused resources')}>⚠ System Prune</button>
            </div>
            {pulling && (
              <div style={S.progressWrap}>
                <span style={S.progressLabel}>Pulling {pulling}...</span>
                <div style={S.progressTrack}><div style={S.progressBar} /></div>
              </div>
            )}
          </div>
          <div style={S.card}>
            <div style={S.searchRow}>
              <input style={{ ...S.searchInput, borderColor: imgSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
                placeholder="Search images…" value={imgSearch} onChange={e => setImgSearch(e.target.value)} />
              {imgSearch && <button style={S.searchClear} onClick={() => setImgSearch('')}>✕</button>}
              <span style={S.searchCount}>{sortedImages.length}/{images.length}</span>
            </div>
            {images.length === 0 ? <p style={S.muted}>No images found.</p> : (
              <table style={S.table}>
                <thead><tr>
                  <th style={S.th}>Repository:Tag</th>
                  <th style={S.thSort} onClick={() => handleImgSort('owner')}>Owner{imgSortCol === 'owner' ? sortArrow(imgSortDir) : ''}</th>
                  <th style={S.th}>ID</th><th style={S.th}>Size</th><th style={S.th}>Actions</th>
                </tr></thead>
                <tbody>
                  {sortedImages.map(img => {
                    const id = getId(img); const owner = img._owner || 'user';
                    return (
                      <tr key={id + owner + getImageName(img)} style={S.tr}>
                        <td style={S.td}><strong>{getImageName(img)}</strong></td>
                        <td style={S.td}><span style={{ ...S.stateBadge, background: ownerColor(owner) }}>{owner}</span></td>
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{id}</td>
                        <td style={S.td}>{formatSize(img.Size)}</td>
                        <td style={S.td}>
                          {confirmingRemove === `img:${id}:${owner}` ? (
                            <span style={S.confirmInline}>
                              <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                              <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => { setConfirmingRemove(null); requestPrivileged('remove_image', `Remove image ${getImageName(img)}`, id, { force: true, owner }); }}>Yes</button>
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
        <div>
          {/* Toolbar */}
          <div style={{ ...S.card, marginBottom: '1rem' }}>
            <div style={S.searchRow}>
              <input style={{ ...S.searchInput, borderColor: volSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
                placeholder="Search volumes by name…" value={volSearch} onChange={e => setVolSearch(e.target.value)} />
              {volSearch && <button style={S.searchClear} onClick={() => setVolSearch('')}>✕</button>}
              <span style={S.searchCount}>{filteredVols.length}/{volumes.length}</span>
              <button style={S.btn} onClick={refreshVolumes} title="Refresh">↻</button>
              <button style={{ ...S.btn, ...(showCreateVol ? { background: 'color-mix(in srgb, var(--c-blue) 20%, transparent)', color: 'var(--c-blue)', borderColor: 'var(--c-blue)' } : {}) }}
                onClick={() => setShowCreateVol(v => !v)}>
                {showCreateVol ? '✕ Cancel' : '+ Create Volume'}
              </button>
              <button style={S.btn} onClick={() => requestPrivileged('volume_prune', 'Remove unused volumes')}>🗑 Prune Unused</button>
            </div>

            {/* Create Volume form */}
            {showCreateVol && (
              <div style={S.createForm}>
                <div style={S.formGrid}>
                  <label style={S.label}>Name *
                    <input style={{ ...S.input, borderColor: volForm.name ? 'var(--c-blue)' : 'var(--c-green)' }}
                      placeholder="my-volume" value={volForm.name} onChange={e => setVolForm({ ...volForm, name: e.target.value })} />
                  </label>
                  <label style={S.label}>Driver (optional)
                    <input style={{ ...S.input, borderColor: volForm.driver ? 'var(--c-blue)' : 'var(--c-green)' }}
                      placeholder="local" value={volForm.driver} onChange={e => setVolForm({ ...volForm, driver: e.target.value })} />
                  </label>
                </div>
                <div style={S.section}>
                  <div style={S.sectionHeader}>
                    <span style={S.sectionTitle}>Labels</span>
                    <button style={S.addBtn} onClick={() => setVolForm({ ...volForm, labels: [...volForm.labels, { key: '', value: '' }] })}>+ Add</button>
                  </div>
                  {volForm.labels.map((l, i) => (
                    <div key={i} style={S.pairRow}>
                      <input style={{ ...S.inputSm, borderColor: l.key ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="key" value={l.key}
                        onChange={e => { const ls = [...volForm.labels]; ls[i] = { ...l, key: e.target.value }; setVolForm({ ...volForm, labels: ls }); }} />
                      <span style={S.muted}>=</span>
                      <input style={{ ...S.inputSm, borderColor: l.value ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="value" value={l.value}
                        onChange={e => { const ls = [...volForm.labels]; ls[i] = { ...l, value: e.target.value }; setVolForm({ ...volForm, labels: ls }); }} />
                      {volForm.labels.length > 1 && <button style={S.rmBtn} onClick={() => setVolForm({ ...volForm, labels: volForm.labels.filter((_, j) => j !== i) })}>✕</button>}
                    </div>
                  ))}
                </div>
                <button style={{ ...S.btn, marginTop: '0.75rem' }} disabled={!volForm.name.trim()}
                  onClick={() => { sendAction('volume_create', { name: volForm.name.trim(), driver: volForm.driver.trim(), labels: volForm.labels.filter(l => l.key) }); }}>
                  Create Volume
                </button>
              </div>
            )}
          </div>

          {/* Volume list */}
          <div style={S.card}>
            {volumes.length === 0 ? <p style={S.muted}>No volumes found. Click ↻ to load.</p>
              : filteredVols.length === 0 ? <p style={S.muted}>No volumes match the filter.</p>
              : (
                <table style={S.table}>
                  <thead><tr>
                    <th style={S.th}>Name</th><th style={S.th}>Driver</th><th style={S.th}>Owner</th>
                    <th style={S.th}>Scope</th><th style={S.th}>Mountpoint</th><th style={S.th}>Actions</th>
                  </tr></thead>
                  <tbody>
                    {filteredVols.map(v => {
                      const name = v.Name || '—'; const owner = v._owner || 'user'; const key = `vol:${name}:${owner}`;
                      return (
                        <tr key={key} style={S.tr}>
                          <td style={S.td}><strong>{name}</strong></td>
                          <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{v.Driver || '—'}</td>
                          <td style={S.td}><span style={{ ...S.stateBadge, background: ownerColor(owner) }}>{owner}</span></td>
                          <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{v.Scope || '—'}</td>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-2)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={getVolMount(v)}>{getVolMount(v)}</td>
                          <td style={S.td}>
                            <div style={S.actions}>
                              <button style={S.actBtn} title="Inspect" onClick={() => { sendAction('volume_inspect', { name, owner }); }}>🔍</button>
                              {confirmingRemove === key ? (
                                <span style={S.confirmInline}>
                                  <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                                  <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => { setConfirmingRemove(null); if (su.active) { sendAction('volume_remove', { name, owner }); } else { setPendingAction({ action: 'volume_remove', label: `Remove volume ${name}`, extra: { name, owner } }); setPassword(''); setError(null); } }}>Yes</button>
                                  <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                                </span>
                              ) : (
                                <button style={{ ...S.actBtn, color: 'var(--c-red)' }} onClick={() => setConfirmingRemove(key)} title="Remove">✕</button>
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
        </div>
      )}

      {/* ── Networks tab ── */}
      {tab === 'networks' && (
        <div>
          {/* Toolbar */}
          <div style={{ ...S.card, marginBottom: '1rem' }}>
            <div style={S.searchRow}>
              <input style={{ ...S.searchInput, borderColor: netSearch ? 'var(--c-blue)' : 'var(--c-green)' }}
                placeholder="Search networks by name…" value={netSearch} onChange={e => setNetSearch(e.target.value)} />
              {netSearch && <button style={S.searchClear} onClick={() => setNetSearch('')}>✕</button>}
              <span style={S.searchCount}>{filteredNets.length}/{networks.length}</span>
              <button style={S.btn} onClick={refreshNetworks} title="Refresh">↻</button>
              <button style={{ ...S.btn, ...(showCreateNet ? { background: 'color-mix(in srgb, var(--c-blue) 20%, transparent)', color: 'var(--c-blue)', borderColor: 'var(--c-blue)' } : {}) }}
                onClick={() => setShowCreateNet(v => !v)}>
                {showCreateNet ? '✕ Cancel' : '+ Create Network'}
              </button>
              <button style={S.btn} onClick={() => requestPrivileged('network_prune', 'Remove unused networks')}>🗑 Prune Unused</button>
            </div>

            {/* Create Network form */}
            {showCreateNet && (
              <div style={S.createForm}>
                <div style={S.formGrid}>
                  <label style={S.label}>Name *
                    <input style={{ ...S.input, borderColor: netForm.name ? 'var(--c-blue)' : 'var(--c-green)' }}
                      placeholder="my-network" value={netForm.name} onChange={e => setNetForm({ ...netForm, name: e.target.value })} />
                  </label>
                  <label style={S.label}>Driver
                    <select style={{ ...S.input, borderColor: 'var(--c-green)' }} value={netForm.driver} onChange={e => setNetForm({ ...netForm, driver: e.target.value })}>
                      {NET_DRIVERS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </label>
                  <label style={S.label}>Subnet (optional)
                    <input style={{ ...S.input, borderColor: netForm.subnet ? 'var(--c-blue)' : 'var(--c-green)' }}
                      placeholder="192.168.1.0/24" value={netForm.subnet} onChange={e => setNetForm({ ...netForm, subnet: e.target.value })} />
                  </label>
                  <label style={S.label}>Gateway (optional)
                    <input style={{ ...S.input, borderColor: netForm.gateway ? 'var(--c-blue)' : 'var(--c-green)' }}
                      placeholder="192.168.1.1" value={netForm.gateway} onChange={e => setNetForm({ ...netForm, gateway: e.target.value })} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-2)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={netForm.internal} onChange={e => setNetForm({ ...netForm, internal: e.target.checked })} />
                    Internal (no external access)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                    <input type="checkbox" checked={netForm.ipv6} onChange={e => setNetForm({ ...netForm, ipv6: e.target.checked })} />
                    Enable IPv6
                  </label>
                </div>
                <button style={{ ...S.btn, marginTop: '0.75rem' }} disabled={!netForm.name.trim()}
                  onClick={() => { sendAction('network_create', { name: netForm.name.trim(), driver: netForm.driver, subnet: netForm.subnet.trim(), gateway: netForm.gateway.trim(), internal: netForm.internal, ipv6: netForm.ipv6 }); }}>
                  Create Network
                </button>
              </div>
            )}
          </div>

          {/* Network list */}
          <div style={S.card}>
            {networks.length === 0 ? <p style={S.muted}>No networks found. Click ↻ to load.</p>
              : filteredNets.length === 0 ? <p style={S.muted}>No networks match the filter.</p>
              : (
                <table style={S.table}>
                  <thead><tr>
                    <th style={S.th}>Name</th><th style={S.th}>Driver</th><th style={S.th}>Owner</th>
                    <th style={S.th}>Scope</th><th style={S.th}>ID</th><th style={S.th}>Actions</th>
                  </tr></thead>
                  <tbody>
                    {filteredNets.map(n => {
                      const name = getNetName(n); const id = getNetId(n); const owner = n._owner || 'user';
                      const key = `net:${id}:${owner}`; const builtin = BUILTIN_NETS.has(name);
                      return (
                        <tr key={key} style={S.tr}>
                          <td style={S.td}><strong>{name}</strong></td>
                          <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{getNetDriver(n)}</td>
                          <td style={S.td}><span style={{ ...S.stateBadge, background: ownerColor(owner) }}>{owner}</span></td>
                          <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{getNetScope(n)}</td>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{id}</td>
                          <td style={S.td}>
                            <div style={S.actions}>
                              <button style={S.actBtn} title="Inspect" onClick={() => { sendAction('network_inspect', { id: name, owner }); }}>🔍</button>
                              {builtin ? (
                                <span style={{ ...S.muted, fontSize: '0.75rem', padding: '0 0.4rem' }}>built-in</span>
                              ) : confirmingRemove === key ? (
                                <span style={S.confirmInline}>
                                  <span style={{ color: 'var(--c-red)', fontSize: '0.75rem' }}>Sure?</span>
                                  <button style={{ ...S.actBtn, color: 'var(--c-red)', fontWeight: 600 }} onClick={() => { setConfirmingRemove(null); if (su.active) { sendAction('network_remove', { id: name, owner }); } else { setPendingAction({ action: 'network_remove', label: `Remove network ${name}`, extra: { id: name, owner } }); setPassword(''); setError(null); } }}>Yes</button>
                                  <button style={S.actBtn} onClick={() => setConfirmingRemove(null)}>No</button>
                                </span>
                              ) : (
                                <button style={{ ...S.actBtn, color: 'var(--c-red)' }} onClick={() => setConfirmingRemove(key)} title="Remove">✕</button>
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
        </div>
      )}

      {/* ── Create Container tab ── */}
      {tab === 'create' && (
        <div style={S.card}>
          <h3 style={S.formTitle}>Create New Container</h3>
          <div style={S.formGrid}>
            <label style={S.label}>Image *
              <input style={{ ...S.input, borderColor: form.image ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="nginx:latest" value={form.image}
                onChange={e => setForm({ ...form, image: e.target.value })} />
            </label>
            <label style={S.label}>Name
              <input style={{ ...S.input, borderColor: form.name ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="my-container" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })} />
            </label>
          </div>

          {[
            { title: 'Port Mappings', items: form.ports, key: 'ports' as const, ph: ['Host port', 'Container port'], sep: '→', add: { host: '', container: '' }, left: 'host' as const, right: 'container' as const },
            { title: 'Volume Mounts', items: form.volumes, key: 'volumes' as const, ph: ['Host path', 'Container path'], sep: '→', add: { host: '', container: '' }, left: 'host' as const, right: 'container' as const },
          ].map(({ title, items, key, ph, sep, add, left, right }) => (
            <div key={key} style={S.section}>
              <div style={S.sectionHeader}>
                <span style={S.sectionTitle}>{title}</span>
                <button style={S.addBtn} onClick={() => setForm({ ...form, [key]: [...(form[key] as typeof items), add] })}>+ Add</button>
              </div>
              {(items as Array<{ host: string; container: string }>).map((item, i) => (
                <div key={i} style={S.pairRow}>
                  <input style={{ ...S.inputSm, borderColor: item[left] ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder={ph[0]} value={item[left]}
                    onChange={e => { const arr = [...(form[key] as typeof items)] as Array<{ host: string; container: string }>; arr[i] = { ...item, [left]: e.target.value }; setForm({ ...form, [key]: arr }); }} />
                  <span style={S.muted}>{sep}</span>
                  <input style={{ ...S.inputSm, borderColor: item[right] ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder={ph[1]} value={item[right]}
                    onChange={e => { const arr = [...(form[key] as typeof items)] as Array<{ host: string; container: string }>; arr[i] = { ...item, [right]: e.target.value }; setForm({ ...form, [key]: arr }); }} />
                  {items.length > 1 && <button style={S.rmBtn} onClick={() => setForm({ ...form, [key]: (items as typeof items).filter((_, j) => j !== i) })}>✕</button>}
                </div>
              ))}
            </div>
          ))}

          <div style={S.section}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>Environment Variables</span>
              <button style={S.addBtn} onClick={() => setForm({ ...form, env: [...form.env, { key: '', value: '' }] })}>+ Add</button>
            </div>
            {form.env.map((e, i) => (
              <div key={i} style={S.pairRow}>
                <input style={{ ...S.inputSm, borderColor: e.key ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="KEY" value={e.key}
                  onChange={ev => { const env = [...form.env]; env[i] = { ...e, key: ev.target.value }; setForm({ ...form, env }); }} />
                <span style={S.muted}>=</span>
                <input style={{ ...S.inputSm, borderColor: e.value ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="value" value={e.value}
                  onChange={ev => { const env = [...form.env]; env[i] = { ...e, value: ev.target.value }; setForm({ ...form, env }); }} />
                {form.env.length > 1 && <button style={S.rmBtn} onClick={() => setForm({ ...form, env: form.env.filter((_, j) => j !== i) })}>✕</button>}
              </div>
            ))}
          </div>

          <div style={S.formGrid}>
            <label style={S.label}>Restart Policy
              <select style={{ ...S.input, borderColor: form.restart ? 'var(--c-blue)' : 'var(--c-green)' }} value={form.restart}
                onChange={e => setForm({ ...form, restart: e.target.value })}>
                <option value="">None</option>
                <option value="always">Always</option>
                <option value="unless-stopped">Unless Stopped</option>
                <option value="on-failure">On Failure</option>
              </select>
            </label>
            <label style={S.label}>Command (optional)
              <input style={{ ...S.input, borderColor: form.command ? 'var(--c-blue)' : 'var(--c-green)' }} placeholder="e.g. /bin/sh" value={form.command}
                onChange={e => setForm({ ...form, command: e.target.value })} />
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
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Logs: {logs.id}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ ...S.muted, fontSize: '0.75rem' }}>Lines:</span>
                <select style={{ ...S.inputSm, width: 80, flex: 'none' }} value={logsTail}
                  onChange={e => setLogsTail(Number(e.target.value))}>
                  <option value={50}>50</option><option value={200}>200</option>
                  <option value={500}>500</option><option value={1000}>1000</option>
                  <option value={0}>All</option>
                </select>
                <button style={S.actBtn} title="Reload" onClick={() => { if (logs) sendAction('logs', { id: logs.id, tail: logsTail, owner: logs.owner }); }}>↻</button>
                <button style={S.actBtn} onClick={() => setLogs(null)}>✕</button>
              </div>
            </div>
            <pre ref={logsPreRef} style={S.logsPre}>{stripAnsi(logs.text) || '(empty)'}</pre>
          </div>
        </div>
      )}

      {/* ── Volume inspect modal ── */}
      {volInspect && (
        <div style={S.overlay} onClick={() => setVolInspect(null)}>
          <div style={{ ...S.modal, maxWidth: 640 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Volume: {volInspect.Name || '—'}</h3>
              <button style={S.actBtn} onClick={() => setVolInspect(null)}>✕</button>
            </div>
            <div style={S.inspectGrid}>
              <InspectRow label="Driver" value={volInspect.Driver || '—'} />
              <InspectRow label="Scope" value={volInspect.Scope || '—'} />
              <InspectRow label="Created" value={volInspect.CreatedAt ? new Date(volInspect.CreatedAt).toLocaleString() : '—'} />
              <InspectRow label="Mountpoint" value={getVolMount(volInspect)} mono />
              <InspectRow label="Labels" value={renderKV(volInspect.Labels || undefined)} mono />
              <InspectRow label="Options" value={renderKV(volInspect.Options || undefined)} mono />
            </div>
          </div>
        </div>
      )}

      {/* ── Network inspect modal ── */}
      {netInspect && (
        <div style={S.overlay} onClick={() => setNetInspect(null)}>
          <div style={{ ...S.modal, maxWidth: 720 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Network: {niName(netInspect)}</h3>
              <button style={S.actBtn} onClick={() => setNetInspect(null)}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {/* Basic info */}
              <div style={S.inspectGrid}>
                <InspectRow label="Driver" value={niDriver(netInspect)} />
                <InspectRow label="Scope" value={niScope(netInspect)} />
                <InspectRow label="Internal" value={niInternal(netInspect) ? 'Yes' : 'No'} />
                <InspectRow label="IPv6" value={niIPv6(netInspect) ? 'Enabled' : 'Disabled'} />
                {(netInspect.dns_enabled !== undefined) && <InspectRow label="DNS" value={netInspect.dns_enabled ? 'Enabled' : 'Disabled'} />}
                <InspectRow label="Labels" value={renderKV(netInspect.Labels || netInspect.labels || undefined)} mono />
              </div>

              {/* Subnets */}
              {niSubnets(netInspect).length > 0 && (
                <div style={{ marginTop: '1rem' }}>
                  <div style={S.inspectSection}>IPAM Configuration</div>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Subnet</th><th style={S.th}>Gateway</th></tr></thead>
                    <tbody>
                      {niSubnets(netInspect).map((s, i) => (
                        <tr key={i} style={S.tr}>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.85rem' }}>{s.subnet}</td>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.85rem' }}>{s.gateway}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Connected containers */}
              <div style={{ marginTop: '1rem' }}>
                <div style={S.inspectSection}>Connected Containers</div>
                {niContainers(netInspect).length === 0 ? (
                  <p style={{ ...S.muted, padding: '0.25rem 0' }}>No containers connected.</p>
                ) : (
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Name</th><th style={S.th}>ID</th><th style={S.th}>IP Address</th><th style={S.th}></th></tr></thead>
                    <tbody>
                      {niContainers(netInspect).map(c => (
                        <tr key={c.id} style={S.tr}>
                          <td style={S.td}><strong>{c.name}</strong></td>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>{c.id}</td>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.85rem' }}>{c.ip}</td>
                          <td style={S.td}>
                            <button style={{ ...S.actBtn, fontSize: '0.75rem' }} title="Disconnect"
                              onClick={() => sendAction('network_disconnect', { network: niName(netInspect), container: c.id })}>
                              Disconnect
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {/* Connect container */}
                {containers.length > 0 && (
                  <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' as const }}>
                    <span style={{ ...S.muted, fontSize: '0.8rem' }}>Connect:</span>
                    <select style={{ ...S.inputSm, flex: 1, minWidth: 160 }} value={connectCtr}
                      onChange={e => setConnectCtr(e.target.value)}>
                      <option value="">— select container —</option>
                      {containers.map(c => {
                        const cid = getId(c); const cname = getContainerName(c);
                        return <option key={cid + (c._owner || '')} value={cid}>{cname} ({cid})</option>;
                      })}
                    </select>
                    <button style={S.btn} disabled={!connectCtr}
                      onClick={() => { if (connectCtr) sendAction('network_connect', { network: niName(netInspect), container: connectCtr }); }}>
                      Connect
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {ctrInspect && (() => {
        const ci = ctrInspect;
        const name = (ci.Name || '').replace(/^\//, '') || (ci.Id ? ci.Id.slice(0, 12) : 'container');
        const cmd = [...(ci.Config?.Entrypoint || []), ...(ci.Config?.Cmd || [])].join(' ');
        const ports = Object.entries(ci.NetworkSettings?.Ports || {})
          .flatMap(([k, arr]) => (arr || []).map(b => `${b.HostIp || '0.0.0.0'}:${b.HostPort || ''} → ${k}`));
        const mounts = (ci.Mounts || []).map(m => `${m.Name || m.Source || '?'} → ${m.Destination || '?'}${m.RW === false ? ' (ro)' : ''}`);
        const nets = Object.entries(ci.NetworkSettings?.Networks || {}).map(([n, i]) => `${n}: ${i.IPAddress || '—'}`);
        if (nets.length === 0 && ci.NetworkSettings?.IPAddress) nets.push(ci.NetworkSettings.IPAddress);
        const env = ci.Config?.Env || [];
        const detTitle: React.CSSProperties = { color: 'var(--text-2)', fontSize: '0.8rem', margin: '0.7rem 0 0.3rem' };
        const detMono: React.CSSProperties = { fontFamily: 'monospace', fontSize: '0.82rem', padding: '0.15rem 0', wordBreak: 'break-all' };
        return (
          <div style={S.overlay} onClick={() => setCtrInspect(null)}>
            <div style={{ ...S.modal, maxWidth: 720 }} onClick={e => e.stopPropagation()}>
              <div style={S.modalHeader}>
                <h3 style={{ margin: 0 }}>Container: {name}</h3>
                <button style={S.actBtn} onClick={() => setCtrInspect(null)}>✕</button>
              </div>
              <div style={S.inspectGrid}>
                <InspectRow label="Image" value={ci.Config?.Image || '—'} mono />
                <InspectRow label="Command" value={cmd || '—'} mono />
                <InspectRow label="Status" value={`${ci.State?.Status || '?'}${ci.State?.Health?.Status ? ` · ${ci.State.Health.Status}` : ''}`} />
                <InspectRow label="Created" value={ci.Created ? new Date(ci.Created).toLocaleString() : '—'} />
                <InspectRow label="Restart" value={ci.HostConfig?.RestartPolicy?.Name || '—'} />
                <InspectRow label="Working dir" value={ci.Config?.WorkingDir || '—'} mono />
              </div>
              {ports.length > 0 && <><div style={detTitle}>Ports</div>{ports.map((p, i) => <div key={i} style={detMono}>{p}</div>)}</>}
              {mounts.length > 0 && <><div style={detTitle}>Mounts</div>{mounts.map((m, i) => <div key={i} style={detMono}>{m}</div>)}</>}
              {nets.length > 0 && <><div style={detTitle}>Networks</div>{nets.map((n, i) => <div key={i} style={detMono}>{n}</div>)}</>}
              {env.length > 0 && (
                <>
                  <div style={detTitle}>Environment ({env.length})</div>
                  <pre style={{ margin: 0, maxHeight: 200, overflow: 'auto', background: 'var(--bg-app)', padding: '0.5rem', borderRadius: 6, fontSize: '0.78rem', fontFamily: 'monospace' }}>{env.join('\n')}</pre>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {execTarget && (
        <ContainerExec
          container={execTarget.id}
          label={execTarget.name}
          password={su.password}
          onClose={() => setExecTarget(null)}
        />
      )}
    </div>
  );
}

/* ── InspectRow helper ─────────────────────────────────── */

function InspectRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', padding: '0.3rem 0', borderBottom: '1px solid var(--bg-surface)', alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--text-2)', fontSize: '0.8rem', minWidth: 100, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.85rem', fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' as const }}>{value}</span>
    </div>
  );
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  header: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' },
  runtimeBadge: { background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)', color: 'var(--c-blue)', padding: '0.2rem 0.6rem', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' as const },
  muted: { color: 'var(--text-2)', fontSize: '0.85rem' },
  card: { background: 'var(--bg-panel)', borderRadius: '10px', padding: '1rem 1.25rem' },
  error: { background: 'color-mix(in srgb, var(--c-red) 13%, transparent)', border: '1px solid color-mix(in srgb, var(--c-red) 27%, transparent)', borderRadius: 6, padding: '0.5rem 1rem', marginBottom: '1rem', color: 'var(--c-red)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem' },
  errorClose: { background: 'none', border: 'none', color: 'var(--c-red)', cursor: 'pointer', fontSize: '1rem' },
  serviceBar: { display: 'flex', alignItems: 'center', gap: '0.75rem', background: 'var(--bg-panel)', borderRadius: 8, padding: '0.5rem 1rem', marginBottom: '1rem', flexWrap: 'wrap' as const },
  stateBadge: { padding: '0.15rem 0.5rem', borderRadius: 4, fontSize: '0.75rem', fontWeight: 600, color: 'var(--badge-fg)' },
  tabs: { display: 'flex', gap: '0.25rem', marginBottom: '1rem', alignItems: 'center', flexWrap: 'wrap' as const },
  tab: { padding: '0.45rem 1rem', borderRadius: '6px 6px 0 0', border: 'none', background: 'var(--bg-panel)', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500 },
  tabActive: { background: 'var(--c-blue)', color: 'var(--bg-app)' },
  btn: { padding: '0.35rem 0.75rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-panel)', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.8rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.85rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em', whiteSpace: 'nowrap' as const },
  thSort: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em', cursor: 'pointer', userSelect: 'none' as const, whiteSpace: 'nowrap' as const },
  tr: { borderBottom: '1px solid var(--bg-surface)' },
  td: { padding: '0.5rem 0.75rem', verticalAlign: 'middle' as const },
  actions: { display: 'flex', gap: '0.25rem' },
  actBtn: { background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-1)', cursor: 'pointer', padding: '0.2rem 0.4rem', fontSize: '0.8rem' },
  pullRow: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' as const },
  formTitle: { marginBottom: '1rem', fontSize: '0.95rem', fontWeight: 600 },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '0.5rem' },
  label: { display: 'flex', flexDirection: 'column' as const, gap: '0.3rem', fontSize: '0.8rem', color: 'var(--text-2)' },
  input: { padding: '0.4rem 0.6rem', borderRadius: 4, border: '1px solid var(--c-green)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none' },
  inputSm: { padding: '0.3rem 0.5rem', borderRadius: 4, border: '1px solid var(--c-green)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.8rem', outline: 'none', flex: 1, minWidth: 0 },
  section: { marginTop: '0.75rem', marginBottom: '0.5rem' },
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' },
  sectionTitle: { fontSize: '0.8rem', color: 'var(--text-2)', fontWeight: 600 },
  addBtn: { background: 'none', border: 'none', color: 'var(--c-blue)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600 },
  rmBtn: { background: 'none', border: 'none', color: 'var(--c-red)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.3rem' },
  pairRow: { display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.3rem' },
  createForm: { marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' },
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: 'var(--bg-panel)', borderRadius: 10, padding: '1rem 1.25rem', width: '80vw', maxWidth: 900, maxHeight: '85vh', display: 'flex', flexDirection: 'column' as const },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  logsPre: { background: 'var(--bg-surface)', borderRadius: 6, padding: '0.75rem', fontSize: '0.75rem', fontFamily: 'monospace', overflow: 'auto', flex: 1, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, maxHeight: '60vh', color: 'var(--text-1)' },
  inspectGrid: { display: 'flex', flexDirection: 'column' as const, gap: 0 },
  inspectSection: { fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: 'var(--text-2)', marginBottom: '0.4rem', paddingBottom: '0.25rem', borderBottom: '1px solid var(--border)' },
  passwordBar: { display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-panel)', borderRadius: 8, padding: '0.5rem 1rem', marginBottom: '1rem', flexWrap: 'wrap' as const },
  passwordLabel: { fontSize: '0.8rem', color: 'var(--text-2)', whiteSpace: 'nowrap' as const },
  passwordInput: { padding: '0.3rem 0.5rem', borderRadius: 4, border: '1px solid var(--c-green)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', width: 200 },
  confirmBtn: { padding: '0.3rem 0.7rem', borderRadius: 4, border: '1px solid color-mix(in srgb, var(--c-green) 40%, transparent)', background: 'color-mix(in srgb, var(--c-green) 13%, transparent)', color: 'var(--c-green)', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer' },
  cancelBtn: { padding: '0.3rem 0.7rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer' },
  infoBanner: { background: 'color-mix(in srgb, var(--c-blue) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--c-blue) 20%, transparent)', borderRadius: 6, padding: '0.4rem 0.75rem', marginBottom: '0.75rem', color: 'var(--c-blue)', fontSize: '0.8rem' },
  searchRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' as const },
  searchInput: { padding: '0.4rem 0.6rem', borderRadius: 4, border: '1px solid var(--c-green)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none', flex: 1, minWidth: 160 },
  searchClear: { background: 'none', border: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.9rem', padding: '0 0.2rem' },
  searchCount: { color: 'var(--text-2)', fontSize: '0.75rem', whiteSpace: 'nowrap' as const },
  confirmInline: { display: 'inline-flex', alignItems: 'center', gap: '0.3rem' },
  progressWrap: { padding: '0.75rem 0 0.25rem' },
  progressLabel: { display: 'block', color: 'var(--text-2)', fontSize: '0.8rem', marginBottom: '0.4rem' },
  progressTrack: { height: 4, borderRadius: 2, background: 'rgba(122,162,247,0.1)', overflow: 'hidden', position: 'relative' as const },
  progressBar: { position: 'absolute' as const, top: 0, left: 0, width: '50%', height: '100%', borderRadius: 2, background: 'linear-gradient(90deg, transparent, var(--c-blue), transparent)', animation: 'progress-slide 1.2s ease-in-out infinite' },
};
