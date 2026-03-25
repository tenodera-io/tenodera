import { useEffect, useState, useRef } from 'react';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

/* ── types ─────────────────────────────────────────────── */

interface IoPoint {
  t: string;
  readKBs: number;
  writeKBs: number;
}

interface BlockDevice {
  name: string;
  size: number;
  type: string;
  mountpoints: string[];
  used: number;
  free: number;
  use_pct: number;
  children?: BlockDevice[];
}

interface FlatRow {
  name: string;
  size: number;
  type: string;
  mountpoints: string[];
  used: number;
  use_pct: number;
  depth: number;
  prefix: string;  // tree connector like "├─" or "└─"
}

const HISTORY_LEN = 90;

/* ── helpers ───────────────────────────────────────────── */

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes >= 1099511627776) return `${(bytes / 1099511627776).toFixed(1)} TiB`;
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GiB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1073741824) return `${(bytesPerSec / 1073741824).toFixed(1)} GiB/s`;
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MiB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KiB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

/* ── tree flatten ──────────────────────────────────────── */

function flattenTree(devices: BlockDevice[]): FlatRow[] {
  const rows: FlatRow[] = [];

  function walk(dev: BlockDevice, depth: number, prefix: string) {
    rows.push({
      name: dev.name,
      size: dev.size,
      type: dev.type,
      mountpoints: dev.mountpoints,
      used: dev.used,
      use_pct: dev.use_pct,
      depth,
      prefix,
    });
    if (dev.children) {
      dev.children.forEach((child, i) => {
        const isLast = i === dev.children!.length - 1;
        walk(child, depth + 1, isLast ? '└─' : '├─');
      });
    }
  }

  for (const dev of devices) {
    walk(dev, 0, '');
  }
  return rows;
}

/* ── tooltip ───────────────────────────────────────────── */

const tooltipStyle: React.CSSProperties = {
  background: '#1a1b26',
  border: '1px solid #292e42',
  borderRadius: 6,
  fontSize: '0.8rem',
  color: '#c0caf5',
};
const tooltipItemStyle: React.CSSProperties = { color: '#c0caf5' };

/* ── component ─────────────────────────────────────────── */

export function Storage() {
  const { openChannel } = useTransport();
  const [history, setHistory] = useState<IoPoint[]>([]);
  const [blockRows, setBlockRows] = useState<FlatRow[]>([]);
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);

  useEffect(() => {
    const ch = openChannel('storage.stream', { interval: 2000 });
    channelRef.current = ch;

    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;

        const io = d.io as { read_bytes_sec: number; write_bytes_sec: number } | undefined;
        const ts = d.timestamp as string | undefined;
        const time = ts ? new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) : '';

        if (io) {
          setHistory((h) => {
            const next = [...h, {
              t: time,
              readKBs: io.read_bytes_sec / 1024,
              writeKBs: io.write_bytes_sec / 1024,
            }];
            return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next;
          });
        }

        const bd = d.block_devices as BlockDevice[] | undefined;
        if (bd) setBlockRows(flattenTree(bd));
      }
    });

    return () => ch.close();
  }, []);

  return (
    <div>
      <h2>Storage</h2>

      {/* ── I/O Charts ── */}
      <div style={S.chartsRow}>
        <div style={S.chartCard}>
          <h3 style={S.chartTitle}>Reading</h3>
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={history} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="readGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7aa2f7" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#7aa2f7" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#565f89' }} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 10, fill: '#565f89' }} unit=" KiB/s"
                  tickFormatter={(v: number) => v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${v.toFixed(0)}`} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((v: unknown) => [formatRate((v as number) * 1024)]) as never} />
                <Area type="monotone" dataKey="readKBs" name="Read" stroke="#7aa2f7" fill="url(#readGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p style={S.muted}>Collecting data…</p>
          )}
        </div>

        <div style={S.chartCard}>
          <h3 style={S.chartTitle}>Writing</h3>
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={history} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="writeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f7768e" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#f7768e" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#565f89' }} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 10, fill: '#565f89' }} unit=" KiB/s"
                  tickFormatter={(v: number) => v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${v.toFixed(0)}`} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((v: unknown) => [formatRate((v as number) * 1024)]) as never} />
                <Area type="monotone" dataKey="writeKBs" name="Write" stroke="#f7768e" fill="url(#writeGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p style={S.muted}>Collecting data…</p>
          )}
        </div>
      </div>

      {/* ── Block Devices table ── */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Filesystems</h3>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Name</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>Mount Points</th>
              <th style={{ ...S.th, width: '40%' }}>Size</th>
            </tr>
          </thead>
          <tbody>
            {blockRows.map((row, i) => {
              const hasMounts = row.mountpoints.length > 0 && row.mountpoints.some(m => !m.startsWith('['));
              return (
                <tr key={`${row.name}-${i}`} style={S.tr}>
                  <td style={{ ...S.td, fontFamily: 'monospace' }}>
                    {row.depth > 0 && (
                      <span style={{ color: '#565f89', marginRight: 2, paddingLeft: (row.depth - 1) * 16 }}>
                        {row.prefix}
                      </span>
                    )}
                    {row.name}
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                    {row.type}
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {row.mountpoints.join(', ') || '—'}
                  </td>
                  <td style={S.td}>
                    <div style={S.sizeCell}>
                      <div style={S.barOuter}>
                        {hasMounts && row.use_pct > 0 && (
                          <div
                            style={{
                              ...S.barInner,
                              width: `${row.use_pct}%`,
                              background: row.use_pct > 90 ? '#f7768e' : row.use_pct > 70 ? '#e0af68' : '#7aa2f7',
                            }}
                          />
                        )}
                      </div>
                      <span style={S.sizeLabel}>
                        {hasMounts && row.used > 0
                          ? `${formatSize(row.used)} / ${formatSize(row.size)}`
                          : formatSize(row.size)}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {blockRows.length === 0 && <p style={S.muted}>Loading block devices…</p>}
      </div>
    </div>
  );
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  chartsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
    marginTop: '1rem',
  },
  chartCard: {
    background: 'var(--bg-secondary)',
    borderRadius: 10,
    padding: '1rem 1.25rem',
  },
  chartTitle: {
    marginBottom: '0.75rem',
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    fontWeight: 600,
  },
  card: {
    background: 'var(--bg-secondary)',
    borderRadius: 10,
    padding: '1rem 1.25rem',
    marginTop: '1rem',
  },
  cardTitle: {
    marginBottom: '0.75rem',
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
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
    padding: '0.6rem 0.75rem',
    fontSize: '0.85rem',
    verticalAlign: 'middle' as const,
  },
  sizeCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  barOuter: {
    flex: 1,
    height: 18,
    background: '#292e42',
    borderRadius: 3,
    overflow: 'hidden' as const,
  },
  barInner: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  sizeLabel: {
    whiteSpace: 'nowrap' as const,
    fontSize: '0.8rem',
    color: 'var(--text-primary)',
    minWidth: 120,
    textAlign: 'right' as const,
  },
};
