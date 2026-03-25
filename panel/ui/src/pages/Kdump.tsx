import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';

/* ── types ─────────────────────────────────────────────── */

interface KdumpStatus {
  installed: boolean;
  service_name: string;
  service_active: string;
  service_enabled: string;
  crash_kernel_loaded: boolean;
  crash_kernel_reserved_bytes: number;
  kernel_version: string;
  kdump_tools: boolean;
  kexec_tools: boolean;
}

interface CrashKernel {
  param: string;
  configured: boolean;
}

interface KdumpConfig {
  path: string | null;
  content: string | null;
}

interface CrashDump {
  name: string;
  path: string;
  type: string;
  size_bytes: number;
  has_vmcore: boolean;
  has_dmesg: boolean;
  timestamp: string;
  files?: { name: string; path: string; size_bytes: number; timestamp: string }[];
}

interface KdumpInfo {
  status: KdumpStatus;
  crashkernel: CrashKernel;
  config: KdumpConfig;
  dumps: CrashDump[];
}

/* ── component ─────────────────────────────────────────── */

export function Kdump() {
  const { request, openChannel } = useTransport();
  const [info, setInfo] = useState<KdumpInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedDump, setExpandedDump] = useState<string | null>(null);
  const [dmesgContent, setDmesgContent] = useState<Record<string, string>>({});
  const [dmesgLoading, setDmesgLoading] = useState<Record<string, boolean>>({});

  const fetchInfo = useCallback(() => {
    setLoading(true);
    setError('');
    request('kdump.info')
      .then((results) => {
        const data = results[0] as KdumpInfo | undefined;
        if (data) setInfo(data);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [request]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  const loadDmesg = useCallback(
    (dumpPath: string) => {
      if (dmesgContent[dumpPath] || dmesgLoading[dumpPath]) return;
      setDmesgLoading((p) => ({ ...p, [dumpPath]: true }));

      const ch = openChannel('kdump.info');
      ch.onMessage((msg) => {
        if (msg.type === 'ready') {
          ch.send({ action: 'read_dmesg', path: dumpPath });
        } else if (msg.type === 'data' && 'data' in msg) {
          const resp = msg.data as { data?: { ok?: boolean; content?: string; error?: string } };
          if (resp.data?.ok && resp.data.content) {
            setDmesgContent((p) => ({ ...p, [dumpPath]: resp.data!.content! }));
          } else {
            setDmesgContent((p) => ({
              ...p,
              [dumpPath]: resp.data?.error || 'No dmesg log found',
            }));
          }
          setDmesgLoading((p) => ({ ...p, [dumpPath]: false }));
          ch.close();
        }
      });
    },
    [openChannel, dmesgContent, dmesgLoading],
  );

  if (loading) return <p>Loading kdump information...</p>;
  if (error) return <p style={{ color: 'var(--danger, #e55)' }}>Error: {error}</p>;
  if (!info) return <p>No kdump data available.</p>;

  const { status, crashkernel, config, dumps } = info;

  return (
    <div>
      <div style={S.header}>
        <h2 style={{ margin: 0 }}>Kernel Dump (kdump)</h2>
        <button onClick={fetchInfo} style={S.btn}>
          Refresh
        </button>
      </div>

      {/* Status overview */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Status</h3>
        <div style={S.grid}>
          <StatusRow label="Installed" value={status.installed ? 'Yes' : 'No'} ok={status.installed} />
          <StatusRow label="Service" value={`${status.service_name} (${status.service_active})`} ok={status.service_active === 'active'} />
          <StatusRow label="Enabled" value={status.service_enabled} ok={status.service_enabled === 'enabled'} />
          <StatusRow label="Crash kernel loaded" value={status.crash_kernel_loaded ? 'Yes' : 'No'} ok={status.crash_kernel_loaded} />
          <StatusRow
            label="Reserved memory"
            value={status.crash_kernel_reserved_bytes > 0 ? formatBytes(status.crash_kernel_reserved_bytes) : 'None'}
            ok={status.crash_kernel_reserved_bytes > 0}
          />
          <StatusRow label="Kernel version" value={status.kernel_version} />
          <StatusRow
            label="Crashkernel param"
            value={crashkernel.configured ? crashkernel.param : 'Not configured'}
            ok={crashkernel.configured}
          />
        </div>
      </div>

      {/* Configuration */}
      {config.content && (
        <div style={S.card}>
          <h3 style={S.cardTitle}>Configuration ({config.path})</h3>
          <pre style={S.pre}>{config.content}</pre>
        </div>
      )}

      {/* Crash dumps */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Crash Dumps ({dumps.length})</h3>
        {dumps.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0' }}>
            No crash dumps found. This is good — no kernel panics recorded.
          </p>
        ) : (
          <div>
            {dumps.map((dump) => (
              <div key={dump.path} style={S.dumpItem}>
                <div
                  style={S.dumpHeader}
                  onClick={() => setExpandedDump(expandedDump === dump.path ? null : dump.path)}
                >
                  <span style={S.dumpToggle}>{expandedDump === dump.path ? '▼' : '▶'}</span>
                  <span style={S.dumpName}>{dump.name}</span>
                  <span style={S.dumpMeta}>
                    {formatBytes(dump.size_bytes)} — {dump.timestamp}
                  </span>
                  <span style={S.dumpBadges}>
                    {dump.has_vmcore && <span style={S.badge}>vmcore</span>}
                    {dump.has_dmesg && <span style={{ ...S.badge, background: 'var(--accent)' }}>dmesg</span>}
                  </span>
                </div>

                {expandedDump === dump.path && (
                  <div style={S.dumpDetails}>
                    {dump.files && dump.files.length > 0 && (
                      <table style={S.table}>
                        <thead>
                          <tr>
                            <th style={S.th}>File</th>
                            <th style={S.th}>Size</th>
                            <th style={S.th}>Modified</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dump.files.map((f) => (
                            <tr key={f.path}>
                              <td style={S.td}>{f.name}</td>
                              <td style={S.td}>{formatBytes(f.size_bytes)}</td>
                              <td style={S.td}>{f.timestamp}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {dump.has_dmesg && (
                      <div style={{ marginTop: '0.5rem' }}>
                        {!dmesgContent[dump.path] && !dmesgLoading[dump.path] && (
                          <button onClick={() => loadDmesg(dump.path)} style={S.btnSmall}>
                            Load dmesg log
                          </button>
                        )}
                        {dmesgLoading[dump.path] && <p>Loading dmesg...</p>}
                        {dmesgContent[dump.path] && (
                          <pre style={S.pre}>{dmesgContent[dump.path]}</pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── helpers ───────────────────────────────────────────── */

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div style={S.statusRow}>
      <span style={S.statusLabel}>{label}</span>
      <span style={{
        ...S.statusValue,
        ...(ok === true ? { color: 'var(--success, #4c6)' } : ok === false ? { color: 'var(--danger, #e55)' } : {}),
      }}>
        {value}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '1rem',
  },
  btn: {
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
  },
  btnSmall: {
    padding: '0.3rem 0.7rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  card: {
    background: 'var(--bg-secondary)',
    borderRadius: '8px',
    padding: '1rem',
    marginBottom: '1rem',
  },
  cardTitle: {
    margin: '0 0 0.75rem 0',
    fontSize: '1.05rem',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '0.5rem',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.35rem 0.5rem',
    borderRadius: '4px',
    background: 'var(--bg-primary, #1a1a2e)',
  },
  statusLabel: {
    color: 'var(--text-secondary)',
    fontSize: '0.9rem',
  },
  statusValue: {
    fontWeight: 600,
    fontSize: '0.9rem',
  },
  pre: {
    background: 'var(--bg-primary, #1a1a2e)',
    padding: '0.75rem',
    borderRadius: '4px',
    overflow: 'auto',
    maxHeight: '400px',
    fontSize: '0.82rem',
    fontFamily: 'monospace',
    margin: 0,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  dumpItem: {
    borderBottom: '1px solid var(--border)',
    padding: '0.5rem 0',
  },
  dumpHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    cursor: 'pointer',
    padding: '0.25rem 0',
  },
  dumpToggle: {
    fontSize: '0.75rem',
    width: '1rem',
    flexShrink: 0,
  },
  dumpName: {
    fontWeight: 600,
    minWidth: '180px',
  },
  dumpMeta: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    flex: 1,
  },
  dumpBadges: {
    display: 'flex',
    gap: '0.3rem',
  },
  badge: {
    padding: '0.15rem 0.5rem',
    borderRadius: '10px',
    fontSize: '0.75rem',
    background: 'var(--warning, #c80)',
    color: '#fff',
    fontWeight: 600,
  },
  dumpDetails: {
    padding: '0.5rem 0 0.5rem 1.5rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.85rem',
  },
  th: {
    textAlign: 'left' as const,
    padding: '0.3rem 0.5rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  td: {
    padding: '0.3rem 0.5rem',
    borderBottom: '1px solid var(--border)',
  },
};
