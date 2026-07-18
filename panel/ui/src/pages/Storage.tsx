import { useEffect, useState, useRef, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';
import { StorageMounts } from './StorageMounts.tsx';
import { StorageUsage } from './StorageUsage.tsx';
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
  inodes_total: number;
  inodes_used: number;
  inodes_pct: number;
  children?: BlockDevice[];
}

interface FlatRow {
  name: string;
  size: number;
  type: string;
  mountpoints: string[];
  used: number;
  use_pct: number;
  inodes_total: number;
  inodes_used: number;
  inodes_pct: number;
  depth: number;
  prefix: string;
}

interface SwapInfo {
  total: number;
  used: number;
  free: number;
  use_pct: number;
}

interface SwapIoPoint {
  t: string;
  inKBs: number;
  outKBs: number;
}

interface DiskIoRate {
  read_bytes_sec: number;
  write_bytes_sec: number;
}

const HISTORY_LEN = 90;

const INTERVAL_OPTIONS = [
  { label: '1 sec',  ms: 1_000 },
  { label: '5 sec',  ms: 5_000 },
  { label: '10 sec', ms: 10_000 },
  { label: '30 sec', ms: 30_000 },
  { label: '1 min',  ms: 60_000 },
  { label: '5 min',  ms: 300_000 },
  { label: '10 min', ms: 600_000 },
  { label: '30 min', ms: 1_800_000 },
];

const INTERVAL_STORAGE_KEY = 'storage_interval';

/* ── helpers ───────────────────────────────────────────── */

function formatInodes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

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
      inodes_total: dev.inodes_total ?? 0,
      inodes_used: dev.inodes_used ?? 0,
      inodes_pct: dev.inodes_pct ?? 0,
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
  background: 'var(--bg-app)',
  border: '1px solid var(--bg-surface)',
  borderRadius: 6,
  fontSize: '0.8rem',
  color: 'var(--text-1)',
};
const tooltipItemStyle: React.CSSProperties = { color: 'var(--text-1)' };

/* ── component ─────────────────────────────────────────── */

export function Storage() {
  const { request } = useTransport();
  const [tab, setTab] = useTabParam<'overview' | 'mounts' | 'usage'>(['overview', 'mounts', 'usage'], 'overview');
  const [history, setHistory] = useState<IoPoint[]>([]);
  const [blockRows, setBlockRows] = useState<FlatRow[]>([]);
  const [swap, setSwap] = useState<SwapInfo | null>(null);
  const [swapHistory, setSwapHistory] = useState<SwapIoPoint[]>([]);
  const [diskIo, setDiskIo] = useState<Record<string, DiskIoRate>>({});
  const mountedRef = useRef(true);
  const prevRequestRef = useRef(request);
  const [intervalMs, setIntervalMs] = useState<number>(() => {
    const saved = sessionStorage.getItem(INTERVAL_STORAGE_KEY);
    const parsed = saved ? Number(saved) : NaN;
    return INTERVAL_OPTIONS.some(o => o.ms === parsed) ? parsed : 60_000;
  });

  const changeInterval = useCallback((ms: number) => {
    setIntervalMs(ms);
    sessionStorage.setItem(INTERVAL_STORAGE_KEY, String(ms));
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // Reset history only when host changes (request reference changed)
    if (prevRequestRef.current !== request) {
      prevRequestRef.current = request;
      setHistory([]);
      setBlockRows([]);
      setSwap(null);
      setSwapHistory([]);
      setDiskIo({});
    }

    const fetchSnapshot = () => {
      request('storage.snapshot').then((results) => {
        if (!mountedRef.current) return;
        const d = results[0] as Record<string, unknown> | undefined;
        if (!d) return;

        const io = d.io as { read_bytes_sec: number; write_bytes_sec: number; disks?: Record<string, DiskIoRate> } | undefined;
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
          if (io.disks) setDiskIo(io.disks);
        }

        const swapData = d.swap as SwapInfo | undefined;
        if (swapData) setSwap(swapData);

        const swapIo = d.swap_io as { bytes_in_sec: number; bytes_out_sec: number } | undefined;
        if (swapIo && time) {
          setSwapHistory((h) => {
            const next = [...h, { t: time, inKBs: swapIo.bytes_in_sec / 1024, outKBs: swapIo.bytes_out_sec / 1024 }];
            return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next;
          });
        }

        const bd = d.block_devices as BlockDevice[] | undefined;
        if (bd) setBlockRows(flattenTree(bd));
      }).catch(() => {});
    };

    // Initial fetch immediately
    fetchSnapshot();

    // Second fetch after 2s for quick chart population
    const kickTimer = setTimeout(() => {
      if (mountedRef.current) fetchSnapshot();
    }, 2000);

    const timer = setInterval(fetchSnapshot, intervalMs);

    return () => {
      mountedRef.current = false;
      clearTimeout(kickTimer);
      clearInterval(timer);
    };
  }, [request, intervalMs]);

  return (
    <div>
      <PageHeader
        icon="storage"
        title="Storage"
        actions={
          <div style={S.intervalBar}>
            <span style={S.intervalLabel}>Refresh</span>
            <select
              value={intervalMs}
              onChange={e => changeInterval(Number(e.target.value))}
              style={S.intervalSelect}
            >
              {INTERVAL_OPTIONS.map(opt => (
                <option key={opt.ms} value={opt.ms}>{opt.label}</option>
              ))}
            </select>
          </div>
        }
      />

      <Tabs
        tabs={[{ id: 'overview', label: 'Overview' }, { id: 'mounts', label: 'Mounts' }, { id: 'usage', label: 'Disk usage' }]}
        active={tab}
        onChange={(t) => setTab(t as 'overview' | 'mounts' | 'usage')}
        style={{ marginBottom: '1rem' }}
      />

      {tab === 'mounts' && <StorageMounts />}

      {tab === 'usage' && <StorageUsage />}

      {tab === 'overview' && (<>
      {/* ── I/O Charts ── */}
      <div style={S.chartsRow}>
        <div style={S.chartCard}>
          <h3 style={S.chartTitle}>Reading</h3>
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={history} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="readGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--c-blue)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--c-blue)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-surface)" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--text-3)' }} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-3)' }} unit=" KiB/s"
                  tickFormatter={(v: number) => v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${v.toFixed(0)}`} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((v: unknown) => [formatRate((v as number) * 1024)]) as never} />
                <Area type="monotone" dataKey="readKBs" name="Read" stroke="var(--c-blue)" fill="url(#readGrad)" />
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
                    <stop offset="0%" stopColor="var(--c-red)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="var(--c-red)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-surface)" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--text-3)' }} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-3)' }} unit=" KiB/s"
                  tickFormatter={(v: number) => v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${v.toFixed(0)}`} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((v: unknown) => [formatRate((v as number) * 1024)]) as never} />
                <Area type="monotone" dataKey="writeKBs" name="Write" stroke="var(--c-red)" fill="url(#writeGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p style={S.muted}>Collecting data…</p>
          )}
        </div>
      </div>

      {/* ── Swap + per-disk I/O ── */}
      <div style={S.metricsRow}>
        <div style={S.card}>
          <h3 style={S.cardTitle}>Swap</h3>
          {!swap ? (
            <p style={S.muted}>Loading…</p>
          ) : swap.total === 0 ? (
            <p style={S.muted}>No swap configured</p>
          ) : (
            <>
              <div style={S.barOuter}>
                <div style={{
                  ...S.barInner,
                  width: `${swap.use_pct}%`,
                  background: swap.use_pct > 80 ? 'var(--c-red)' : swap.use_pct > 50 ? 'var(--c-yellow)' : 'var(--c-purple)',
                }} />
              </div>
              <div style={S.swapStats}>
                <span>{formatSize(swap.used)} used</span>
                <span style={{ fontWeight: 600 }}>{swap.use_pct}%</span>
                <span>{formatSize(swap.total)} total</span>
              </div>
              {swapHistory.length > 1 ? (
                <div style={{ marginTop: '0.75rem' }}>
                  <div style={S.swapIoLegend}>
                    <span style={{ color: 'var(--c-blue)' }}>
                      ↓ {formatRate(swapHistory[swapHistory.length - 1].inKBs * 1024)}
                    </span>
                    <span style={{ color: 'var(--text-3)', fontSize: '0.7rem' }}>swap I/O</span>
                    <span style={{ color: 'var(--c-red)' }}>
                      ↑ {formatRate(swapHistory[swapHistory.length - 1].outKBs * 1024)}
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={80}>
                    <AreaChart data={swapHistory} margin={{ top: 2, right: 0, bottom: 0, left: -40 }}>
                      <defs>
                        <linearGradient id="swapInGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--c-blue)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--c-blue)" stopOpacity={0.03} />
                        </linearGradient>
                        <linearGradient id="swapOutGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--c-red)" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="var(--c-red)" stopOpacity={0.03} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="t" hide />
                      <YAxis hide />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        itemStyle={tooltipItemStyle}
                        labelStyle={tooltipItemStyle}
                        formatter={((v: unknown) => [formatRate((v as number) * 1024)]) as never}
                      />
                      <Area type="monotone" dataKey="inKBs" name="In" stroke="var(--c-blue)" fill="url(#swapInGrad)" strokeWidth={1.5} dot={false} />
                      <Area type="monotone" dataKey="outKBs" name="Out" stroke="var(--c-red)" fill="url(#swapOutGrad)" strokeWidth={1.5} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p style={{ ...S.muted, marginTop: '0.5rem', fontSize: '0.75rem' }}>Collecting swap I/O…</p>
              )}
            </>
          )}
        </div>

        <div style={S.card}>
          <h3 style={S.cardTitle}>Disk I/O</h3>
          {Object.keys(diskIo).length === 0 ? (
            <p style={S.muted}>Loading…</p>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Device</th>
                  <th style={{ ...S.th, textAlign: 'right' as const }}>Read</th>
                  <th style={{ ...S.th, textAlign: 'right' as const }}>Write</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(diskIo)
                  .sort(([, a], [, b]) => (b.read_bytes_sec + b.write_bytes_sec) - (a.read_bytes_sec + a.write_bytes_sec))
                  .map(([name, rates]) => (
                    <tr key={name} style={S.tr}>
                      <td style={{ ...S.td, fontFamily: 'monospace' }}>{name}</td>
                      <td style={{ ...S.td, textAlign: 'right' as const, color: 'var(--c-blue)' }}>{formatRate(rates.read_bytes_sec)}</td>
                      <td style={{ ...S.td, textAlign: 'right' as const, color: 'var(--c-red)' }}>{formatRate(rates.write_bytes_sec)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
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
              <th style={S.th}>Inodes</th>
              <th style={{ ...S.th, width: '35%' }}>Size</th>
            </tr>
          </thead>
          <tbody>
            {blockRows.map((row, i) => {
              const hasMounts = row.mountpoints.length > 0 && row.mountpoints.some(m => !m.startsWith('['));
              return (
                <tr key={`${row.name}-${i}`} style={S.tr}>
                  <td style={{ ...S.td, fontFamily: 'monospace' }}>
                    {row.depth > 0 && (
                      <span style={{ color: 'var(--text-3)', marginRight: 2, paddingLeft: (row.depth - 1) * 16 }}>
                        {row.prefix}
                      </span>
                    )}
                    {row.name}
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>
                    {row.type}
                  </td>
                  <td style={{ ...S.td, color: 'var(--text-2)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                    {row.mountpoints.join(', ') || '—'}
                  </td>
                  <td style={{ ...S.td, fontSize: '0.78rem', whiteSpace: 'nowrap' as const }}>
                    {row.inodes_total === 0 ? (
                      <span style={{ color: 'var(--text-3)' }}>—</span>
                    ) : (
                      <span style={{ color: row.inodes_pct > 80 ? 'var(--c-red)' : row.inodes_pct > 60 ? 'var(--c-yellow)' : 'var(--text-1)' }}>
                        {row.inodes_pct}%{' '}
                        <span style={{ color: 'var(--text-3)', fontSize: '0.72rem' }}>
                          ({formatInodes(row.inodes_used)}/{formatInodes(row.inodes_total)})
                        </span>
                      </span>
                    )}
                  </td>
                  <td style={S.td}>
                    <div style={S.sizeCell}>
                      <div style={S.barOuter}>
                        {hasMounts && row.use_pct > 0 && (
                          <div
                            style={{
                              ...S.barInner,
                              width: `${row.use_pct}%`,
                              background: row.use_pct > 90 ? 'var(--c-red)' : row.use_pct > 70 ? 'var(--c-yellow)' : 'var(--c-blue)',
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
      </>)}
    </div>
  );
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  headerRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  intervalBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
  },
  intervalLabel: {
    fontSize: '0.75rem',
    color: 'var(--text-2)',
    marginRight: '0.25rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  intervalSelect: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--bg-surface)',
    color: 'var(--text-1)',
    padding: '0.25rem 0.5rem',
    borderRadius: 5,
    fontSize: '0.75rem',
    cursor: 'pointer',
    fontWeight: 500,
    outline: 'none',
  },
  chartsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
    marginTop: '1rem',
  },
  metricsRow: {
    display: 'grid',
    gridTemplateColumns: '280px 1fr',
    gap: '1rem',
    marginTop: '1rem',
    alignItems: 'start',
  },
  swapStats: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: '0.5rem',
    fontSize: '0.8rem',
    color: 'var(--text-2)',
  },
  swapIoLegend: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.75rem',
    marginBottom: '0.2rem',
  },
  chartCard: {
    background: 'var(--bg-panel)',
    borderRadius: 10,
    padding: '1rem 1.25rem',
  },
  chartTitle: {
    marginBottom: '0.75rem',
    fontSize: '0.85rem',
    color: 'var(--text-2)',
    fontWeight: 600,
  },
  card: {
    background: 'var(--bg-panel)',
    borderRadius: 10,
    padding: '1rem 1.25rem',
    marginTop: '1rem',
  },
  cardTitle: {
    marginBottom: '0.75rem',
    fontSize: '0.8rem',
    color: 'var(--text-2)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  muted: {
    color: 'var(--text-2)',
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
    color: 'var(--text-2)',
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  tr: {
    borderBottom: '1px solid var(--bg-surface)',
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
    background: 'var(--bg-surface)',
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
    color: 'var(--text-1)',
    minWidth: 120,
    textAlign: 'right' as const,
  },
};
