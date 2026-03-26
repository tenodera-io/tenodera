import { useEffect, useState, useCallback, useRef } from 'react';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from './Shell.tsx';

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
}

interface ContainerImage {
  Id?: string;
  ID?: string;
  Repository?: string;
  RepoTags?: string[];
  Tag?: string;
  Size?: number;
  Created?: string | number;
}

interface ServiceStatus {
  service: string;
  active: string;
  enabled: string;
}

type Tab = 'containers' | 'images' | 'create';

/* ── helpers ───────────────────────────────────────────── */

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

/* ── component ─────────────────────────────────────────── */

export function Containers() {
  const { openChannel } = useTransport();
  const su = useSuperuser();
  const [runtime, setRuntime] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<ContainerImage[]>([]);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [tab, setTab] = useState<Tab>('containers');
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

  const sendAction = useCallback((action: string, extra: Record<string, unknown> = {}) => {
    channelRef.current?.send({ action, ...extra });
  }, []);

  const refresh = useCallback(() => {
    sendAction('list_containers');
    sendAction('list_images');
    sendAction('service_status');
  }, [sendAction]);

  useEffect(() => {
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
            ch.send({ action: 'list_containers' });
            ch.send({ action: 'list_images' });
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
            if (data && typeof data === 'object' && 'error' in data && data.error) {
              setError(`${action}: ${data.error}`);
            }
            // Refresh after any mutation
            setTimeout(() => refresh(), 500);
          } else if (['service_start', 'service_stop', 'service_restart'].includes(action)) {
            setTimeout(() => sendAction('service_status'), 500);
          }
        }

        if (d.type === 'error') {
          setError(String(d.error));
          setLoading(false);
        }
      }
    });

    return () => ch.close();
  }, [refresh, sendAction]);

  const requestPrivileged = (action: string, label: string, id?: string, extra?: Record<string, unknown>) => {
    if (su.active) {
      /* superuser mode — execute immediately with stored password */
      setLoading(true);
      setError(null);
      const payload: Record<string, unknown> = { password: su.password, ...extra };
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
    setTab('containers');
  };

  const handlePull = () => {
    if (!pullImage.trim()) return;
    requestPrivileged('pull', `Pull ${pullImage.trim()}`, undefined, { image: pullImage.trim() });
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

      {/* Tabs */}
      <div style={S.tabs}>
        {(['containers', 'images', 'create'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
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
          {containers.length === 0 ? (
            <p style={S.muted}>No containers found.</p>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Image</th>
                  <th style={S.th}>State</th>
                  <th style={S.th}>Status</th>
                  <th style={S.th}>ID</th>
                  <th style={S.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => {
                  const id = getId(c);
                  const state = (c.State || '').toLowerCase();
                  return (
                    <tr key={id} style={S.tr}>
                      <td style={S.td}><strong>{getContainerName(c)}</strong></td>
                      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{c.Image}</td>
                      <td style={S.td}>
                        <span style={{ ...S.stateBadge, background: stateColor(c.State) + '22', color: stateColor(c.State) }}>
                          {c.State}
                        </span>
                      </td>
                      <td style={{ ...S.td, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{c.Status}</td>
                      <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{id}</td>
                      <td style={S.td}>
                        <div style={S.actions}>
                          {state !== 'running' && (
                            <button style={S.actBtn} onClick={() => requestPrivileged('start', `Start ${getContainerName(c)}`, id)} title="Start">▶</button>
                          )}
                          {state === 'running' && (
                            <button style={S.actBtn} onClick={() => requestPrivileged('stop', `Stop ${getContainerName(c)}`, id)} title="Stop">■</button>
                          )}
                          <button style={S.actBtn} onClick={() => requestPrivileged('restart', `Restart ${getContainerName(c)}`, id)} title="Restart">↻</button>
                          <button style={S.actBtn} onClick={() => {
                            sendAction('logs', { id, tail: 200 });
                          }} title="Logs">📋</button>
                          <button style={{ ...S.actBtn, color: '#f7768e' }} onClick={() => {
                            if (confirm(`Remove container ${getContainerName(c)}?`))
                              requestPrivileged('remove', `Remove ${getContainerName(c)}`, id, { force: state === 'running' });
                          }} title="Remove">✕</button>
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
              />
              <button style={S.btn} onClick={handlePull} disabled={loading || !pullImage.trim()}>
                Pull Image
              </button>
            </div>
          </div>
          <div style={S.card}>
            {images.length === 0 ? (
              <p style={S.muted}>No images found.</p>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Repository:Tag</th>
                    <th style={S.th}>ID</th>
                    <th style={S.th}>Size</th>
                    <th style={S.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {images.map((img) => {
                    const id = getId(img);
                    return (
                      <tr key={id + getImageName(img)} style={S.tr}>
                        <td style={S.td}><strong>{getImageName(img)}</strong></td>
                        <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{id}</td>
                        <td style={S.td}>{formatSize(img.Size)}</td>
                        <td style={S.td}>
                          <button style={{ ...S.actBtn, color: '#f7768e' }} onClick={() => {
                            if (confirm(`Remove image ${getImageName(img)}?`))
                              requestPrivileged('remove_image', `Remove image ${getImageName(img)}`, id, { force: false });
                          }} title="Remove">✕</button>
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
};
