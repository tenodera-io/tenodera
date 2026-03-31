import { useEffect, useState, useRef, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  BarChart, Bar, LineChart, Line, Legend,
} from 'recharts';

/* ── types ─────────────────────────────────────────────── */

interface SystemInfo {
  hostname: string;
  os: Record<string, string>;
  uptime_secs?: number;
  boot_time?: string;
}

interface SnapshotMetrics {
  timestamp: string;
  cpu: { user_pct: number; system_pct: number; idle_pct: number } | null;
  cpu_cores: { core: string; usage_pct: number }[] | null;
  memory: { memtotal?: number; memfree?: number; memavailable?: number } | null;
  swap: { total: number; free: number; used: number } | null;
  loadavg: { '1min': number; '5min': number; '15min': number } | null;
  disk_io: { read_bytes_sec: number; write_bytes_sec: number } | null;
  net_io: { rx_bytes_sec: number; tx_bytes_sec: number } | null;
}

interface HistoryPoint {
  t: string;
  cpuUser: number;
  cpuSys: number;
  memUsedPct: number;
  load1: number;
  diskReadRate: number;
  diskWriteRate: number;
  netRxRate: number;
  netTxRate: number;
}

interface DiskPartition {
  device: string;
  mount: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
  avail: number;
  use_pct: number;
}

interface NetInterface {
  name: string;
  state: string;
  mac: string;
  speed_mbps: number | null;
  ipv4: string[];
  ipv6: string[];
  rx_bytes: number;
  rx_packets: number;
  rx_errors: number;
  tx_bytes: number;
  tx_packets: number;
  tx_errors: number;
}

interface HardwareInfo {
  cpu_model: string;
  cpu_cores: number;
  cpu_threads: number;
  cpu_mhz: number;
  architecture: string;
  kernel: string;
  temperatures: { label: string; sensor: string; temp_c: number; crit_c: number | null }[];
}

interface TopProcess {
  pid: number;
  user: string;
  cpu_pct: number;
  mem_pct: number;
  rss_kb: number;
  command: string;
}

const HISTORY_LEN = 60;
const COLORS = {
  user:   '#7aa2f7',  // blue
  system: '#f7768e',  // red
  idle:   '#33394d',  // muted
  used:   '#e0af68',  // amber
  avail:  '#9ece6a',  // green
  free:   '#33394d',
};

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

const INTERVAL_STORAGE_KEY = 'dashboard_interval';

/* ── component ─────────────────────────────────────────── */

export function Dashboard() {
  const { request } = useTransport();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotMetrics | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [disks, setDisks] = useState<DiskPartition[]>([]);
  const [netIfaces, setNetIfaces] = useState<NetInterface[]>([]);
  const [hwInfo, setHwInfo] = useState<HardwareInfo | null>(null);
  const [topProcs, setTopProcs] = useState<TopProcess[]>([]);
  const [procSort, setProcSort] = useState<'cpu' | 'mem'>('cpu');
  const [intervalMs, setIntervalMs] = useState<number>(() => {
    const saved = sessionStorage.getItem(INTERVAL_STORAGE_KEY);
    const parsed = saved ? Number(saved) : NaN;
    return INTERVAL_OPTIONS.some(o => o.ms === parsed) ? parsed : 60_000;
  });

  const mountedRef = useRef(true);
  const prevRequestRef = useRef(request);

  const changeInterval = useCallback((ms: number) => {
    setIntervalMs(ms);
    sessionStorage.setItem(INTERVAL_STORAGE_KEY, String(ms));
  }, []);

  // ── One-shot static data (loaded once per host) ──
  useEffect(() => {
    request('system.info').then((results) => {
      if (results[0]) setInfo(results[0] as SystemInfo);
    });
    request('disk.usage').then((results) => {
      const data = results[0] as { partitions: DiskPartition[] } | undefined;
      if (data?.partitions) setDisks(data.partitions);
    });
    request('network.stats').then((results) => {
      const data = results[0] as { interfaces: NetInterface[] } | undefined;
      if (data?.interfaces) setNetIfaces(data.interfaces);
    });
    request('hardware.info').then((results) => {
      if (results[0]) setHwInfo(results[0] as HardwareInfo);
    });
  }, [request]);

  // ── Polling: metrics snapshot + top processes ──
  useEffect(() => {
    mountedRef.current = true;

    // Reset history only when host changes (request reference changed)
    if (prevRequestRef.current !== request) {
      prevRequestRef.current = request;
      setHistory([]);
      setSnapshot(null);
      setTopProcs([]);
      setInfo(null);
      setDisks([]);
      setNetIfaces([]);
      setHwInfo(null);
    }

    const fetchSnapshot = () => {
      request('metrics.snapshot').then((results) => {
        if (!mountedRef.current) return;
        const m = results[0] as SnapshotMetrics | undefined;
        if (!m) return;

        setSnapshot(m);

        // Append to history
        const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-GB', { hour12: false }) : '';
        const memTotal = m.memory?.memtotal ?? 1;
        const memAvail = m.memory?.memavailable ?? memTotal;
        const memUsedPct = Math.round(((memTotal - memAvail) / memTotal) * 100);

        setHistory((h) => {
          const next = [...h, {
            t: time,
            cpuUser: m.cpu?.user_pct ?? 0,
            cpuSys: m.cpu?.system_pct ?? 0,
            memUsedPct,
            load1: m.loadavg?.['1min'] ?? 0,
            diskReadRate: m.disk_io?.read_bytes_sec ?? 0,
            diskWriteRate: m.disk_io?.write_bytes_sec ?? 0,
            netRxRate: m.net_io?.rx_bytes_sec ?? 0,
            netTxRate: m.net_io?.tx_bytes_sec ?? 0,
          }];
          return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next;
        });
      }).catch(() => {});
    };

    const fetchProcs = () => {
      request('top.processes').then((results) => {
        if (!mountedRef.current) return;
        const data = results[0] as { processes: TopProcess[] } | undefined;
        if (data?.processes) setTopProcs(data.processes);
      }).catch(() => {});
    };

    // Initial fetch immediately
    fetchSnapshot();
    fetchProcs();

    // Second fetch after 2s for quick chart population
    const kickTimer = setTimeout(() => {
      if (mountedRef.current) {
        fetchSnapshot();
        fetchProcs();
      }
    }, 2000);

    const timer = setInterval(() => {
      fetchSnapshot();
      fetchProcs();
    }, intervalMs);

    return () => {
      mountedRef.current = false;
      clearTimeout(kickTimer);
      clearInterval(timer);
    };
  }, [request, intervalMs]);

  /* memory breakdown for pie */
  const memTotal = snapshot?.memory?.memtotal ?? 0;
  const memFree  = snapshot?.memory?.memfree ?? 0;
  const memAvail = snapshot?.memory?.memavailable ?? 0;
  const memUsed  = memTotal - memAvail;

  /* swap */
  const swapTotal = snapshot?.swap?.total ?? 0;
  const swapUsed  = snapshot?.swap?.used ?? 0;
  const swapFree  = snapshot?.swap?.free ?? 0;
  const swapUsedPct = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

  const swapPie = swapTotal > 0
    ? [
        { name: 'Used',  value: swapUsed, color: '#bb9af7' },
        { name: 'Free',  value: swapFree, color: '#33394d' },
      ]
    : [];

  const cpuPct = snapshot?.cpu ?? null;
  const corePcts = snapshot?.cpu_cores ?? [];

  const cpuPie = cpuPct
    ? [
        { name: 'User',   value: cpuPct.user_pct,   color: COLORS.user },
        { name: 'System', value: cpuPct.system_pct,  color: COLORS.system },
        { name: 'Idle',   value: cpuPct.idle_pct,    color: COLORS.idle },
      ]
    : [];

  const memPie = memTotal > 0
    ? [
        { name: 'Used',      value: memUsed,                          color: COLORS.used },
        { name: 'Available', value: Math.max(0, memAvail - memFree),  color: COLORS.avail },
        { name: 'Free',      value: memFree,                          color: COLORS.free },
      ]
    : [];

  const cpuTotalPct = cpuPct ? cpuPct.user_pct + cpuPct.system_pct : 0;
  const memUsedPct  = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

  const sortedProcs = [...topProcs].sort((a, b) =>
    procSort === 'cpu' ? b.cpu_pct - a.cpu_pct : b.mem_pct - a.mem_pct
  );

  return (
    <div>
      <div style={styles.headerRow}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <div style={styles.intervalBar}>
          <span style={styles.intervalLabel}>Refresh</span>
          <select
            value={intervalMs}
            onChange={e => changeInterval(Number(e.target.value))}
            style={styles.intervalSelect}
          >
            {INTERVAL_OPTIONS.map(opt => (
              <option key={opt.ms} value={opt.ms}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Row 1: Host + CPU donut + Memory donut ── */}
      <div className="dashboard-grid3" style={styles.grid3}>
        <Card title="Host">
          {info ? (
            <>
              <Stat label="Hostname" value={info.hostname} />
              <Stat label="OS" value={info.os?.pretty_name || info.os?.name || '—'} />
              <Stat label="ID" value={info.os?.id || '—'} />
              {info.uptime_secs != null && (
                <Stat label="Uptime" value={formatUptime(info.uptime_secs)} />
              )}
              {info.boot_time && (
                <Stat label="Up since" value={info.boot_time} />
              )}
            </>
          ) : (
            <p style={styles.muted}>Loading…</p>
          )}
        </Card>

        <Card title="CPU">
          {cpuPct ? (
            <DonutChart data={cpuPie} centerLabel={`${cpuTotalPct}%`} />
          ) : (
            <p style={styles.muted}>Waiting…</p>
          )}
        </Card>

        <Card title="Memory">
          {memTotal > 0 ? (
            <DonutChart data={memPie} centerLabel={`${memUsedPct}%`}
              tooltipFmt={(v) => formatKb(v)} />
          ) : (
            <p style={styles.muted}>Waiting…</p>
          )}
        </Card>
      </div>

      {/* ── Row 2: Hardware Info + Swap + Temperatures ── */}
      <div className="dashboard-grid3" style={styles.grid3}>
        <Card title="Hardware">
          {hwInfo ? (
            <>
              <Stat label="CPU" value={hwInfo.cpu_model || '—'} />
              <Stat label="Cores / Threads" value={`${hwInfo.cpu_cores} / ${hwInfo.cpu_threads}`} />
              <Stat label="Max MHz" value={hwInfo.cpu_mhz ? `${hwInfo.cpu_mhz.toFixed(0)} MHz` : '—'} />
              <Stat label="Architecture" value={hwInfo.architecture} />
              <Stat label="Kernel" value={hwInfo.kernel} />
            </>
          ) : (
            <p style={styles.muted}>Loading…</p>
          )}
        </Card>

        <Card title="Swap">
          {swapTotal > 0 ? (
            <DonutChart data={swapPie} centerLabel={`${swapUsedPct}%`}
              tooltipFmt={(v) => formatKb(v)} />
          ) : (
            <p style={styles.muted}>No swap</p>
          )}
        </Card>

        <Card title="Temperatures">
          {hwInfo && hwInfo.temperatures.length > 0 ? (
            <div style={{ fontSize: '0.8rem' }}>
              {hwInfo.temperatures.map((t, i) => (
                <div key={i} style={styles.tempRow}>
                  <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{t.label}</span>
                  <span style={{
                    fontWeight: 600,
                    color: t.crit_c && t.temp_c > t.crit_c * 0.85 ? '#f7768e'
                         : t.temp_c > 70 ? '#e0af68' : '#9ece6a',
                  }}>
                    {t.temp_c.toFixed(1)}°C
                  </span>
                  {t.crit_c && (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginLeft: '0.5rem' }}>
                      / {t.crit_c.toFixed(0)}°C
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p style={styles.muted}>No sensors</p>
          )}
        </Card>
      </div>

      {/* ── Network Interfaces (side by side) ── */}
      {netIfaces.length > 0 && (
        <div style={styles.grid1}>
          <Card title="Network Interfaces">
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(netIfaces.length, 4)}, 1fr)`,
              gap: '0.75rem',
            }}>
              {netIfaces.map((iface) => (
                <div key={iface.name} style={styles.netCard}>
                  <div style={styles.netHeader}>
                    <span style={styles.netName}>{iface.name}</span>
                    <span style={{
                      ...styles.netBadge,
                      background: iface.state === 'up' ? '#9ece6a22' : '#f7768e22',
                      color: iface.state === 'up' ? '#9ece6a' : '#f7768e',
                    }}>{iface.state}</span>
                    {iface.speed_mbps && iface.speed_mbps > 0 && (
                      <span style={styles.netSpeed}>{iface.speed_mbps} Mbps</span>
                    )}
                  </div>
                  <div style={styles.netMac}>{iface.mac}</div>
                  {iface.ipv4?.length > 0 && (
                    <div style={styles.netAddr}>
                      <span style={styles.netAddrLabel}>IPv4</span>
                      {iface.ipv4.map((a) => <span key={a} style={styles.netAddrValue}>{a}</span>)}
                    </div>
                  )}
                  {iface.ipv6?.length > 0 && (
                    <div style={{ ...styles.netAddr, flexDirection: 'column', alignItems: 'flex-start', gap: '0.15rem' }}>
                      <span style={styles.netAddrLabel}>IPv6</span>
                      {iface.ipv6.map((a) => <span key={a} style={styles.netAddrValue}>{a}</span>)}
                    </div>
                  )}
                  <div style={styles.netTraffic}>
                    <div style={styles.netDir}>
                      <span style={{ color: '#9ece6a', fontSize: '0.75rem' }}>▼ IN</span>
                      <span style={{ fontWeight: 600 }}>{formatBytes(iface.rx_bytes)}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                        {iface.rx_packets.toLocaleString()} pkts
                        {iface.rx_errors > 0 && <span style={{ color: '#f7768e' }}> / {iface.rx_errors} err</span>}
                      </span>
                    </div>
                    <div style={styles.netDir}>
                      <span style={{ color: '#7aa2f7', fontSize: '0.75rem' }}>▲ OUT</span>
                      <span style={{ fontWeight: 600 }}>{formatBytes(iface.tx_bytes)}</span>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                        {iface.tx_packets.toLocaleString()} pkts
                        {iface.tx_errors > 0 && <span style={{ color: '#f7768e' }}> / {iface.tx_errors} err</span>}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── Disk Usage + Load Average ── */}
      <div className="dashboard-grid2" style={styles.grid2}>
        {disks.length > 0 ? (
          <Card title="Disk Usage">
            <ResponsiveContainer width="100%" height={Math.max(150, disks.length * 40)}>
              <BarChart data={disks} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" horizontal={false} />
                <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: '#565f89' }} />
                <YAxis type="category" dataKey="mount" width={100} tick={{ fontSize: 10, fill: '#c0caf5' }} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((value: unknown) => [`${value}%`]) as never} />
                <Bar dataKey="use_pct" name="Used" radius={[0, 4, 4, 0]}>
                  {disks.map((d, i) => (
                    <Cell key={i} fill={d.use_pct > 90 ? '#f7768e' : d.use_pct > 70 ? '#e0af68' : '#7aa2f7'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div style={styles.diskTable}>
              <div style={styles.diskRow}>
                <span style={styles.diskHeader}>Mount</span>
                <span style={styles.diskHeader}>Device</span>
                <span style={styles.diskHeader}>FS</span>
                <span style={styles.diskHeader}>Total</span>
                <span style={styles.diskHeader}>Used</span>
                <span style={styles.diskHeader}>Avail</span>
              </div>
              {disks.map((d) => (
                <div key={d.mount} style={styles.diskRow}>
                  <span style={styles.diskCell}>{d.mount}</span>
                  <span style={{ ...styles.diskCell, color: 'var(--text-secondary)' }}>{d.device.split('/').pop()}</span>
                  <span style={{ ...styles.diskCell, color: 'var(--text-secondary)' }}>{d.fstype}</span>
                  <span style={styles.diskCell}>{formatBytes(d.total)}</span>
                  <span style={styles.diskCell}>{formatBytes(d.used)}</span>
                  <span style={styles.diskCell}>{formatBytes(d.avail)}</span>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card title="Disk Usage">
            <p style={styles.muted}>No disks</p>
          </Card>
        )}

        <Card title="Load Average">
          {snapshot?.loadavg ? (
            <div style={styles.loadGrid}>
              <LoadRing label="1 min"  value={snapshot.loadavg['1min']} cpuCount={hwInfo?.cpu_threads ?? 0} />
              <LoadRing label="5 min"  value={snapshot.loadavg['5min']} cpuCount={hwInfo?.cpu_threads ?? 0} />
              <LoadRing label="15 min" value={snapshot.loadavg['15min']} cpuCount={hwInfo?.cpu_threads ?? 0} />
            </div>
          ) : (
            <p style={styles.muted}>Waiting…</p>
          )}
        </Card>
      </div>

      {/* ── Row 4: CPU history + Memory history ── */}
      <div className="dashboard-grid2" style={styles.grid2}>
        <Card title="CPU History">
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={history} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="cpuUserGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.user} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={COLORS.user} stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="cpuSysGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.system} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={COLORS.system} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#565f89' }} interval="preserveEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#565f89' }} unit="%" />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle} />
                <Area type="monotone" dataKey="cpuUser" name="User" stackId="1"
                  stroke={COLORS.user} fill="url(#cpuUserGrad)" />
                <Area type="monotone" dataKey="cpuSys" name="System" stackId="1"
                  stroke={COLORS.system} fill="url(#cpuSysGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p style={styles.muted}>Collecting data…</p>
          )}
        </Card>

        <Card title="Memory History">
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={history} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.used} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={COLORS.used} stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#565f89' }} interval="preserveEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#565f89' }} unit="%" />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle} />
                <Area type="monotone" dataKey="memUsedPct" name="Used"
                  stroke={COLORS.used} fill="url(#memGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p style={styles.muted}>Collecting data…</p>
          )}
        </Card>
      </div>

      {/* ── Row 5: Network Traffic History + Disk I/O History ── */}
      <div className="dashboard-grid2" style={styles.grid2}>
        <Card title="Network Traffic">
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history} margin={{ top: 5, right: 5, bottom: 0, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#565f89' }} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 10, fill: '#565f89' }}
                  tickFormatter={(v: number) => formatRate(v)} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((v: unknown) => formatRate(Number(v))) as never} />
                <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
                <Line type="monotone" dataKey="netRxRate" name="▼ RX" stroke="#9ece6a"
                  dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="netTxRate" name="▲ TX" stroke="#7aa2f7"
                  dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p style={styles.muted}>Collecting data…</p>
          )}
        </Card>

        <Card title="Disk I/O">
          {history.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history} margin={{ top: 5, right: 5, bottom: 0, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#292e42" />
                <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#565f89' }} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 10, fill: '#565f89' }}
                  tickFormatter={(v: number) => formatRate(v)} />
                <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                  formatter={((v: unknown) => formatRate(Number(v))) as never} />
                <Legend wrapperStyle={{ fontSize: '0.75rem' }} />
                <Line type="monotone" dataKey="diskReadRate" name="Read" stroke="#7dcfff"
                  dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="diskWriteRate" name="Write" stroke="#ff9e64"
                  dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p style={styles.muted}>Collecting data…</p>
          )}
        </Card>
      </div>

      {/* ── Row 6: CPU Cores ── */}
      {corePcts.length > 0 && (
        <div style={styles.grid1}>
          <Card title={`CPU Cores (${corePcts.length})`}>
            <div style={styles.coreGrid}>
              {corePcts.map((c) => (
                <div key={c.core} style={styles.coreItem}>
                  <div style={styles.coreLabel}>{c.core.replace('cpu', 'C')}</div>
                  <div style={styles.coreBarBg}>
                    <div style={{
                      ...styles.coreBarFill,
                      width: `${c.usage_pct}%`,
                      background: c.usage_pct > 90 ? '#f7768e' : c.usage_pct > 60 ? '#e0af68' : '#7aa2f7',
                    }} />
                  </div>
                  <div style={styles.corePct}>{c.usage_pct}%</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── Row 7: Top Processes ── */}
      <div style={styles.grid1}>
        <Card title="Top Processes">
          {topProcs.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <button style={{
                  ...styles.sortBtn,
                  ...(procSort === 'cpu' ? styles.sortBtnActive : {}),
                }} onClick={() => setProcSort('cpu')}>Sort by CPU</button>
                <button style={{
                  ...styles.sortBtn,
                  ...(procSort === 'mem' ? styles.sortBtnActive : {}),
                }} onClick={() => setProcSort('mem')}>Sort by Memory</button>
              </div>
              <div style={styles.procTable}>
                <div style={styles.procRowHeader}>
                  <span style={{ ...styles.procHeader, width: 60 }}>PID</span>
                  <span style={{ ...styles.procHeader, width: 80 }}>User</span>
                  <span style={{ ...styles.procHeader, width: 65, textAlign: 'right' }}>CPU%</span>
                  <span style={{ ...styles.procHeader, width: 65, textAlign: 'right' }}>MEM%</span>
                  <span style={{ ...styles.procHeader, width: 80, textAlign: 'right' }}>RSS</span>
                  <span style={{ ...styles.procHeader, flex: 1 }}>Command</span>
                </div>
                {sortedProcs.slice(0, 15).map((p) => (
                  <div key={p.pid} style={styles.procRow}>
                    <span style={{ ...styles.procCell, width: 60, fontFamily: 'monospace' }}>{p.pid}</span>
                    <span style={{ ...styles.procCell, width: 80, color: 'var(--text-secondary)' }}>{p.user}</span>
                    <span style={{
                      ...styles.procCell, width: 65, textAlign: 'right', fontWeight: 600,
                      color: p.cpu_pct > 50 ? '#f7768e' : p.cpu_pct > 20 ? '#e0af68' : '#c0caf5',
                    }}>{p.cpu_pct.toFixed(1)}</span>
                    <span style={{
                      ...styles.procCell, width: 65, textAlign: 'right', fontWeight: 600,
                      color: p.mem_pct > 50 ? '#f7768e' : p.mem_pct > 20 ? '#e0af68' : '#c0caf5',
                    }}>{p.mem_pct.toFixed(1)}</span>
                    <span style={{ ...styles.procCell, width: 80, textAlign: 'right', color: 'var(--text-secondary)' }}>
                      {formatKb(p.rss_kb)}
                    </span>
                    <span style={{ ...styles.procCell, flex: 1, fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {p.command}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={styles.muted}>Loading…</p>
          )}
        </Card>
      </div>

    </div>
  );
}

/* ── sub-components ────────────────────────────────────── */

function DonutChart({ data, centerLabel, tooltipFmt }: {
  data: { name: string; value: number; color: string }[];
  centerLabel: string;
  tooltipFmt?: (v: number) => string;
}) {
  return (
    <div style={{ position: 'relative', width: '100%', height: 180 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius="60%" outerRadius="85%"
            paddingAngle={2} startAngle={90} endAngle={-270} stroke="none">
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip
            contentStyle={tooltipStyle}
            wrapperStyle={{ zIndex: 10 }}
            position={{ x: 0, y: -10 }}
            formatter={((value: unknown, name: unknown, props: { payload?: { color?: string } }) => {
              const raw = props?.payload?.color || '#c0caf5';
              const color = ensureReadable(raw);
              return [
                <span style={{ color }}>{tooltipFmt ? tooltipFmt(Number(value)) : `${value}%`}</span>,
                <span style={{ color }}>{String(name)}</span>,
              ];
            }) as never}
          />
        </PieChart>
      </ResponsiveContainer>
      <div style={styles.donutCenter}>
        <span style={styles.donutLabel}>{centerLabel}</span>
      </div>
      <div style={styles.legend}>
        {data.map((d) => (
          <span key={d.name} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, background: d.color }} />
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function LoadRing({ label, value, cpuCount }: { label: string; value: number; cpuCount: number }) {
  const maxLoad = cpuCount > 0 ? cpuCount : 8;
  const pct = Math.min((value / maxLoad) * 100, 100);
  const rest = 100 - pct;
  const color = value < 1 ? '#9ece6a' : value < maxLoad ? '#e0af68' : '#f7768e';
  const bgColor = '#292e42';

  const data = [
    { name: 'Load', value: pct, color },
    { name: 'Rest', value: rest, color: bgColor },
  ];

  const size = 160;

  return (
    <div style={{ textAlign: 'center', flex: '1 1 0', minWidth: 0, maxWidth: 200 }}>
      <div style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" innerRadius="68%" outerRadius="95%"
              startAngle={90} endAngle={-270} paddingAngle={0} stroke="none" isAnimationActive={false}>
              {data.map((d, i) => <Cell key={i} fill={d.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: '1.4rem', fontWeight: 700, color,
          pointerEvents: 'none',
        }}>
          {value.toFixed(2)}
        </div>
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 6 }}>{label}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function formatKb(kb?: number): string {
  if (kb === undefined || kb === 0) return '—';
  if (kb > 1048576) return `${(kb / 1048576).toFixed(1)} GB`;
  if (kb > 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${kb} kB`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes >= 1099511627776) return `${(bytes / 1099511627776).toFixed(1)} TB`;
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1073741824) return `${(bytesPerSec / 1073741824).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** Compute relative luminance and return white if color is too dark on #1a1b26 bg */
function ensureReadable(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.15 ? '#c0caf5' : hex;
}

/* ── styles ────────────────────────────────────────────── */

const tooltipStyle: React.CSSProperties = {
  background: '#1a1b26',
  border: '1px solid #292e42',
  borderRadius: 6,
  fontSize: '0.8rem',
  color: '#c0caf5',
};

const tooltipItemStyle: React.CSSProperties = {
  color: '#c0caf5',
};

const styles: Record<string, React.CSSProperties> = {
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
    color: 'var(--text-secondary)',
    marginRight: '0.25rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  intervalSelect: {
    background: '#292e42',
    border: '1px solid #292e42',
    color: '#c0caf5',
    padding: '0.25rem 0.5rem',
    borderRadius: 5,
    fontSize: '0.75rem',
    cursor: 'pointer',
    fontWeight: 500,
    outline: 'none',
  },
  grid3: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '1rem',
    marginTop: '1rem',
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '1rem',
    marginTop: '1rem',
  },
  grid1: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '1rem',
    marginTop: '1rem',
  },
  card: {
    background: 'var(--bg-secondary)',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  cardTitle: {
    marginBottom: '0.75rem',
    fontSize: '0.8rem',
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  stat: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.3rem 0',
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
  },
  donutCenter: {
    position: 'absolute' as const,
    top: '43%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    textAlign: 'center' as const,
    pointerEvents: 'none' as const,
  },
  donutLabel: {
    fontSize: '1.5rem',
    fontWeight: 700,
  },
  legend: {
    display: 'flex',
    justifyContent: 'center',
    gap: '0.75rem',
    marginTop: '-0.25rem',
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
  },
  legendDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  loadGrid: {
    display: 'flex',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    padding: '1rem 0',
    flex: 1,
    overflow: 'hidden',
  },
  diskTable: {
    marginTop: '0.75rem',
    fontSize: '0.8rem',
  },
  diskRow: {
    display: 'grid',
    gridTemplateColumns: '1.5fr 1fr 0.6fr 0.8fr 0.8fr 0.8fr',
    padding: '0.25rem 0',
    borderBottom: '1px solid #292e42',
    gap: '0.5rem',
  },
  diskHeader: {
    color: 'var(--text-secondary)',
    fontSize: '0.7rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  diskCell: {
    fontSize: '0.8rem',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
  },
  netCard: {
    background: '#1a1b2688',
    borderRadius: 8,
    padding: '0.75rem 1rem',
  },
  netHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.25rem',
  },
  netName: {
    fontWeight: 700,
    fontSize: '1rem',
  },
  netBadge: {
    fontSize: '0.65rem',
    padding: '0.1rem 0.4rem',
    borderRadius: 4,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  netSpeed: {
    fontSize: '0.75rem',
    color: 'var(--text-secondary)',
    marginLeft: 'auto',
  },
  netMac: {
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    fontFamily: 'monospace',
    marginBottom: '0.5rem',
  },
  netAddr: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.5rem',
    flexWrap: 'wrap' as const,
    marginBottom: '0.35rem',
    fontSize: '0.75rem',
  },
  netAddrLabel: {
    color: 'var(--text-secondary)',
    fontSize: '0.65rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    minWidth: 28,
  },
  netAddrValue: {
    fontFamily: 'monospace',
    fontSize: '0.75rem',
    color: '#c0caf5',
  },
  netTraffic: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '0.75rem',
  },
  netDir: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.15rem',
  },
  tempRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '0.3rem 0',
    borderBottom: '1px solid #292e42',
  },
  coreGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: '0.4rem',
  },
  coreItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  coreLabel: {
    fontSize: '0.7rem',
    color: 'var(--text-secondary)',
    width: 28,
    fontFamily: 'monospace',
  },
  coreBarBg: {
    flex: 1,
    height: 10,
    background: '#292e42',
    borderRadius: 5,
    overflow: 'hidden' as const,
  },
  coreBarFill: {
    height: '100%',
    borderRadius: 5,
    transition: 'width 0.5s ease',
  },
  corePct: {
    fontSize: '0.7rem',
    width: 32,
    textAlign: 'right' as const,
    fontFamily: 'monospace',
  },
  sortBtn: {
    background: '#292e42',
    border: 'none',
    color: 'var(--text-secondary)',
    padding: '0.3rem 0.75rem',
    borderRadius: 6,
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  sortBtnActive: {
    background: '#7aa2f733',
    color: '#7aa2f7',
  },
  procTable: {
    fontSize: '0.8rem',
    overflow: 'auto' as const,
  },
  procRowHeader: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.3rem 0',
    borderBottom: '1px solid #292e42',
  },
  procHeader: {
    color: 'var(--text-secondary)',
    fontSize: '0.7rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  procRow: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.25rem 0',
    borderBottom: '1px solid #1a1b2688',
  },
  procCell: {
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
};
