import { useEffect, useState, useRef, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

import type { Message } from '../api/transport.ts';

/* ── types ─────────────────────────────────────────────── */

interface TrafficPoint {
  t: string;
  [key: string]: number | string;  // rx_<iface>, tx_<iface>
}

interface NetInterface {
  name: string;
  state: string;
  mac: string;
  mtu: number;
  link_type: string;
  iface_type: string;
  flags: string[];
  ipv4: string[];
  ipv6: string[];
}

interface FirewallStatusEntry {
  backend: string;
  active: boolean;
  details: string;
}

interface FirewallStatusAll {
  primary: string;
  backends: FirewallStatusEntry[];
}

interface FirewallRule {
  number?: number;
  rule?: string;
  type?: string;
  value?: string;
  zone?: string;
  chain?: string;
  raw?: string;
  backend?: string;
}

interface VpnEntry {
  name: string;
  type: string;
  device: string;
  state: string;
}

/* ── constants ─────────────────────────────────────────── */

type Tab = 'overview' | 'firewall' | 'interfaces' | 'logs';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '📈' },
  { id: 'firewall', label: 'Firewall', icon: '🛡️' },
  { id: 'interfaces', label: 'Interfaces', icon: '🔌' },
  { id: 'logs', label: 'Logs', icon: '📋' },
];

const HISTORY_LEN = 90;
const IFACE_COLORS = ['var(--c-blue)', 'var(--c-red)', 'var(--c-green)', 'var(--c-yellow)', 'var(--c-purple)', 'var(--c-cyan)', 'var(--c-orange)', 'var(--c-teal)'];

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

const INTERVAL_STORAGE_KEY = 'net_interval';

/* ── helpers ────────────────────────────────────────────── */

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1073741824) return `${(bytesPerSec / 1073741824).toFixed(1)} GiB/s`;
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MiB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KiB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function stateColor(state: string): string {
  switch (state.toLowerCase()) {
    case 'up': return 'var(--c-green)';
    case 'down': return 'var(--c-red)';
    case 'lowerlayerdown': return 'var(--c-yellow)';
    default: return 'var(--text-3)';
  }
}

function ifaceIcon(type: string): string {
  switch (type) {
    case 'wireless': return '📶';
    case 'vpn': return '🔐';
    case 'bridge': return '🌉';
    case 'vlan': return '🏷️';
    case 'bond': return '🔗';
    case 'container': return '📦';
    default: return '🔌';
  }
}

/* ── tooltip styling ───────────────────────────────────── */

const tooltipStyle: React.CSSProperties = {
  background: 'var(--bg-app)',
  border: '1px solid var(--bg-surface)',
  borderRadius: 6,
  fontSize: '0.8rem',
  color: 'var(--text-1)',
};
const tooltipItemStyle: React.CSSProperties = { color: 'var(--text-1)' };

/* ── component ─────────────────────────────────────────── */

export function Networking() {
  const { request, openChannel } = useTransport();
  const su = useSuperuser();
  const [tab, changeTab] = useTabParam<Tab>(['overview', 'firewall', 'interfaces', 'logs'], 'overview');

  /* ----- polling interval ----- */
  const [intervalMs, setIntervalMs] = useState<number>(() => {
    const saved = sessionStorage.getItem(INTERVAL_STORAGE_KEY);
    const parsed = saved ? Number(saved) : NaN;
    return INTERVAL_OPTIONS.some(o => o.ms === parsed) ? parsed : 60_000;
  });
  const changeInterval = useCallback((ms: number) => {
    setIntervalMs(ms);
    sessionStorage.setItem(INTERVAL_STORAGE_KEY, String(ms));
  }, []);

  /* ----- traffic chart data ----- */
  const [rxHistory, setRxHistory] = useState<TrafficPoint[]>([]);
  const [txHistory, setTxHistory] = useState<TrafficPoint[]>([]);
  const [ifaceNames, setIfaceNames] = useState<string[]>([]);
  const mountedRef = useRef(true);
  const prevRequestRef = useRef(request);

  /* ----- interfaces ----- */
  const [interfaces, setInterfaces] = useState<NetInterface[]>([]);
  const [ifaceLoading, setIfaceLoading] = useState(false);

  /* ----- firewall ----- */
  const [fwStatus, setFwStatus] = useState<FirewallStatusAll | null>(null);
  const [fwRules, setFwRules] = useState<FirewallRule[]>([]);
  const [fwAvailableBackends, setFwAvailableBackends] = useState<string[]>([]);
  const [fwLoading, setFwLoading] = useState(false);
  const [fwError, setFwError] = useState('');

  /* ----- vpn ----- */
  const [vpns, setVpns] = useState<VpnEntry[]>([]);

  /* ----- logs ----- */
  const [netLogs, setNetLogs] = useState<string[]>([]);
  const [fwLogs, setFwLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  /* ----- firewall rule form ----- */
  const [ruleBackend, setRuleBackend] = useState('');
  const ruleBackendRef = useRef(ruleBackend);
  ruleBackendRef.current = ruleBackend;
  const [rulePort, setRulePort] = useState('');
  const [ruleProto, setRuleProto] = useState('tcp');
  const [ruleAction, setRuleAction] = useState('allow');
  const [ruleFrom, setRuleFrom] = useState('any');
  const [ruleService, setRuleService] = useState('');

  /* ----- bridge/vlan form ----- */
  const [bridgeName, setBridgeName] = useState('');
  const [vlanParent, setVlanParent] = useState('');
  const [vlanId, setVlanId] = useState('');

  /* ----- password prompt ----- */
  const [pwPrompt, setPwPrompt] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [actionError, setActionError] = useState('');

  /* ── manage channel helper ────────────────────────────── */
  const manageRef = useRef<ReturnType<typeof openChannel> | null>(null);
  const pwResolveRef = useRef<((pw: string) => void) | null>(null);

  const getManageChannel = useCallback(() => {
    if (!manageRef.current) {
      const ch = openChannel('networking.manage');
      manageRef.current = ch;
    }
    return manageRef.current;
  }, [openChannel]);

  const sendManage = useCallback((data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    return new Promise((resolve, reject) => {
      const ch = getManageChannel();
      const sentAction = data.action as string | undefined;
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        removeHandler();
        reject(new Error('request timed out'));
      }, 30_000);
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
      setActionError('');
      pwResolveRef.current = resolve;
      setPendingAction(() => () => {
        const el = document.getElementById('net-pw-input') as HTMLInputElement;
        const pw = el?.value || '';
        setPwPrompt(false);
        pwResolveRef.current = null;
        resolve(pw);
      });
    });
  }, [su]);

  /* ── reset state + manage channel on host change ──────── */
  useEffect(() => {
    // Close stale manage channel from previous host
    manageRef.current?.close();
    manageRef.current = null;

    return () => {
      manageRef.current?.close();
      manageRef.current = null;
    };
  }, [request]);

  /* ── polling: networking snapshot ─────────────────────── */
  useEffect(() => {
    mountedRef.current = true;

    // Reset history only when host changes (request reference changed)
    if (prevRequestRef.current !== request) {
      prevRequestRef.current = request;
      setRxHistory([]);
      setTxHistory([]);
      setIfaceNames([]);
      setInterfaces([]);
      setFwStatus(null);
      setFwRules([]);
      setVpns([]);
      setNetLogs([]);
      setFwLogs([]);
    }

    const fetchSnapshot = () => {
      request('networking.snapshot').then((results) => {
        if (!mountedRef.current) return;
        const d = results[0] as Record<string, unknown> | undefined;
        if (!d) return;

        const ts = d.timestamp as string | undefined;
        const time = ts ? new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) : '';
        const ifaces = d.interfaces as { name: string; rx_bps: number; tx_bps: number }[] | undefined;

        if (ifaces) {
          const names = ifaces.map(i => i.name);
          setIfaceNames(prev => {
            const merged = [...new Set([...prev, ...names])];
            return merged.length !== prev.length ? merged : prev;
          });

          const rxPt: TrafficPoint = { t: time };
          const txPt: TrafficPoint = { t: time };
          for (const i of ifaces) {
            rxPt[`rx_${i.name}`] = i.rx_bps;
            txPt[`tx_${i.name}`] = i.tx_bps;
          }

          setRxHistory(h => {
            const next = [...h, rxPt];
            return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next;
          });
          setTxHistory(h => {
            const next = [...h, txPt];
            return next.length > HISTORY_LEN ? next.slice(next.length - HISTORY_LEN) : next;
          });
        }
      }).catch(() => {});
    };

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

  /* ── load interfaces ──────────────────────────────────── */
  const loadInterfaces = useCallback(async () => {
    setIfaceLoading(true);
    try {
      const res = await sendManage({ action: 'list_interfaces' });
      setInterfaces((res.interfaces as NetInterface[]) || []);
    } catch { /* */ }
    setIfaceLoading(false);
  }, [sendManage]);

  /* ── load firewall ────────────────────────────────────── */
  const loadFirewall = useCallback(async () => {
    setFwLoading(true);
    setFwError('');
    try {
      const pw = su.active && su.password ? su.password : '';
      const status = await sendManage({ action: 'firewall_status', password: pw });
      setFwStatus(status as unknown as FirewallStatusAll);
      const available = ((status as unknown as FirewallStatusAll).backends || []).map(b => b.backend);
      setFwAvailableBackends(available);
      if (!ruleBackendRef.current && available.length > 0) {
        setRuleBackend(available.find(b => b === 'ufw' || b === 'firewalld') || available[0]);
      }

      const rules = await sendManage({ action: 'firewall_rules', password: pw });
      setFwRules((rules.rules as FirewallRule[]) || []);
    } catch (e) {
      setFwError(String(e));
    }
    setFwLoading(false);
  }, [sendManage, su]);

  /* ── load VPN ─────────────────────────────────────────── */
  const loadVpn = useCallback(async () => {
    try {
      const res = await sendManage({ action: 'vpn_list' });
      setVpns((res.vpns as VpnEntry[]) || []);
    } catch { /* best-effort */ }
  }, [sendManage]);

  /* ── load logs ────────────────────────────────────────── */
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await sendManage({ action: 'network_logs', lines: 200 });
      setNetLogs((res.network_logs as string[]) || []);
      setFwLogs((res.firewall_logs as string[]) || []);
    } catch { /* best-effort */ }
    setLogsLoading(false);
  }, [sendManage]);

  /* ── load data on tab switch, superuser change, or host change ── */
  useEffect(() => {
    if (tab === 'overview' || tab === 'interfaces') {
      loadInterfaces();
      loadVpn();
    }
    if (tab === 'firewall') loadFirewall();
    if (tab === 'logs') loadLogs();
  }, [tab, su.active, loadInterfaces, loadVpn, loadFirewall, loadLogs]);

  /* ── privileged action helper ─────────────────────────── */
  const doPrivileged = useCallback(async (actionData: Record<string, unknown>) => {
    setActionError('');
    const pw = await getPassword();
    if (!pw) return;
    try {
      const res = await sendManage({ ...actionData, password: pw });
      if (res.error) setActionError(res.error as string);
      return res;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    }
  }, [getPassword, sendManage]);

  /* ───────────────────────────────────────────────────────── */
  /*  Firewall actions                                         */
  /* ───────────────────────────────────────────────────────── */

  const toggleFirewall = async (backend: string, active: boolean) => {
    const action = active ? 'firewall_disable' : 'firewall_enable';
    await doPrivileged({ action, backend });
    loadFirewall();
  };

  const addRule = async () => {
    if (!rulePort && !ruleService) { setActionError('Port or service required'); return; }
    const rule: Record<string, string> = {};
    if (rulePort) {
      rule.port = rulePort;
      rule.proto = ruleProto;
      rule.action = ruleAction;
      rule.from = ruleFrom;
    }
    if (ruleService) rule.service = ruleService;
    await doPrivileged({ action: 'firewall_add_rule', rule, backend: ruleBackend });
    setRulePort('');
    setRuleService('');
    setRuleFrom('any');
    loadFirewall();
  };

  const removeRule = async (rule: FirewallRule) => {
    await doPrivileged({ action: 'firewall_remove_rule', rule, backend: rule.backend });
    loadFirewall();
  };

  /* ── Interface actions ────────────────────────────────── */
  const ifaceAction = async (action: string, name: string) => {
    await doPrivileged({ action, name });
    loadInterfaces();
  };

  const createBridge = async () => {
    if (!bridgeName) { setActionError('Bridge name required'); return; }
    await doPrivileged({ action: 'add_bridge', name: bridgeName });
    setBridgeName('');
    loadInterfaces();
  };

  const createVlan = async () => {
    if (!vlanParent || !vlanId) { setActionError('Parent & VLAN ID required'); return; }
    await doPrivileged({ action: 'add_vlan', parent: vlanParent, vlan_id: Number(vlanId) });
    setVlanParent('');
    setVlanId('');
    loadInterfaces();
  };

  const deleteInterface = async (name: string) => {
    await doPrivileged({ action: 'remove_interface', name });
    loadInterfaces();
  };

  /* ── VPN actions ──────────────────────────────────────── */
  const vpnConnect = async (name: string) => {
    await doPrivileged({ action: 'vpn_connect', name });
    loadVpn();
  };
  const vpnDisconnect = async (name: string) => {
    await doPrivileged({ action: 'vpn_disconnect', name });
    loadVpn();
  };

  /* ═══════════════════════════════════════════════════════ */
  /*  RENDER                                                 */
  /* ═══════════════════════════════════════════════════════ */

  return (
    <div>
      <PageHeader
        icon="networking"
        title="Networking"
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

      {/* ── Tab bar ── */}
      <Tabs
        tabs={TABS.map(t => ({ id: t.id, label: t.label }))}
        active={tab}
        onChange={(t) => changeTab(t as Tab)}
        style={{ marginBottom: '1rem' }}
      />

      {/* ── Error bar ── */}
      {actionError && (
        <div style={S.errorBar}>
          {actionError}
          <button onClick={() => setActionError('')} style={S.errorDismiss}>✕</button>
        </div>
      )}

      {/* ── Password prompt overlay ── */}
      {pwPrompt && (
        <div style={S.overlay}>
          <div style={S.modal}>
            <h3 style={{ marginBottom: '0.75rem' }}>Authentication Required</h3>
            <p style={S.muted}>Enter password for privileged operation</p>
            <input
              id="net-pw-input"
              type="password"
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') pendingAction?.(); }}
              style={{ ...S.input, borderColor: pwInput ? 'var(--c-blue)' : 'var(--c-green)' }}
              autoFocus
              placeholder="Password"
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button onClick={() => pendingAction?.()} style={S.btnPrimary}>Authenticate</button>
              <button onClick={() => { setPwPrompt(false); setPendingAction(null); if (pwResolveRef.current) { pwResolveRef.current(''); pwResolveRef.current = null; } }} style={S.btnSecondary}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════ */}
      {/*  OVERVIEW TAB                                       */}
      {/* ═══════════════════════════════════════════════════ */}

      {tab === 'overview' && (
        <>
          {/* ── TX / RX Charts ── */}
          <div style={S.chartsRow}>
            <div style={S.chartCard}>
              <h3 style={S.chartTitle}>Receiving (RX)</h3>
              {rxHistory.length > 1 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={rxHistory} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <defs>
                      {ifaceNames.map((name, i) => (
                        <linearGradient key={name} id={`rxGrad_${name}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={IFACE_COLORS[i % IFACE_COLORS.length]} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={IFACE_COLORS[i % IFACE_COLORS.length]} stopOpacity={0.05} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-surface)" />
                    <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--text-3)' }} interval="preserveEnd" />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-3)' }}
                      tickFormatter={(v: number) => formatRate(v)} />
                    <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                      formatter={((v: unknown) => [formatRate(v as number)]) as never} />
                    {ifaceNames.map((name, i) => (
                      <Area key={name} type="monotone" dataKey={`rx_${name}`} name={`RX ${name}`}
                        stroke={IFACE_COLORS[i % IFACE_COLORS.length]}
                        fill={`url(#rxGrad_${name})`} stackId="rx" />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <p style={S.muted}>Collecting data…</p>
              )}
            </div>

            <div style={S.chartCard}>
              <h3 style={S.chartTitle}>Transmitting (TX)</h3>
              {txHistory.length > 1 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={txHistory} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <defs>
                      {ifaceNames.map((name, i) => (
                        <linearGradient key={name} id={`txGrad_${name}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={IFACE_COLORS[i % IFACE_COLORS.length]} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={IFACE_COLORS[i % IFACE_COLORS.length]} stopOpacity={0.05} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--bg-surface)" />
                    <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--text-3)' }} interval="preserveEnd" />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-3)' }}
                      tickFormatter={(v: number) => formatRate(v)} />
                    <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipItemStyle}
                      formatter={((v: unknown) => [formatRate(v as number)]) as never} />
                    {ifaceNames.map((name, i) => (
                      <Area key={name} type="monotone" dataKey={`tx_${name}`} name={`TX ${name}`}
                        stroke={IFACE_COLORS[i % IFACE_COLORS.length]}
                        fill={`url(#txGrad_${name})`} stackId="tx" />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <p style={S.muted}>Collecting data…</p>
              )}
            </div>
          </div>

          {/* ── Interface cards ── */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Network Interfaces</h3>
            {ifaceLoading && interfaces.length === 0 ? (
              <p style={S.muted}>Loading…</p>
            ) : (
              <div style={S.ifaceGrid}>
                {interfaces.map(iface => (
                  <div key={iface.name} style={S.ifaceCard}>
                    <div style={S.ifaceHeader}>
                      <span style={{ fontSize: '1.1rem' }}>{ifaceIcon(iface.iface_type)}</span>
                      <span style={S.ifaceName}>{iface.name}</span>
                      <span style={{ ...S.badge, background: stateColor(iface.state) }}>{iface.state}</span>
                      <span style={S.ifaceType}>{iface.iface_type}</span>
                    </div>
                    <div style={S.ifaceBody}>
                      {iface.mac && <div style={S.ifaceRow}><span style={S.ifaceLabel}>MAC</span><span style={S.ifaceVal}>{iface.mac}</span></div>}
                      <div style={S.ifaceRow}><span style={S.ifaceLabel}>MTU</span><span style={S.ifaceVal}>{iface.mtu}</span></div>
                      {iface.ipv4.length > 0 && (
                        <div style={S.ifaceRow}>
                          <span style={S.ifaceLabel}>IPv4</span>
                          <span style={S.ifaceVal}>{iface.ipv4.join(', ')}</span>
                        </div>
                      )}
                      {iface.ipv6.length > 0 && (
                        <div style={S.ifaceRow}>
                          <span style={S.ifaceLabel}>IPv6</span>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            {iface.ipv6.map((ip, i) => (
                              <span key={i} style={S.ifaceVal}>{ip}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── VPN connections ── */}
          {vpns.length > 0 && (
            <div style={S.card}>
              <h3 style={S.cardTitle}>VPN Connections</h3>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Name</th>
                    <th style={S.th}>Type</th>
                    <th style={S.th}>Device</th>
                    <th style={S.th}>State</th>
                    <th style={S.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {vpns.map(v => (
                    <tr key={v.name} style={S.tr}>
                      <td style={S.td}>🔐 {v.name}</td>
                      <td style={{ ...S.td, color: 'var(--text-2)' }}>{v.type}</td>
                      <td style={S.td}>{v.device || '—'}</td>
                      <td style={S.td}>
                        <span style={{ ...S.badge, background: v.device ? 'var(--c-green)' : 'var(--text-3)' }}>
                          {v.device ? 'connected' : 'disconnected'}
                        </span>
                      </td>
                      <td style={S.td}>
                        {v.device ? (
                          <button onClick={() => vpnDisconnect(v.name)} style={S.btnDanger}>Disconnect</button>
                        ) : (
                          <button onClick={() => vpnConnect(v.name)} style={S.btnPrimary}>Connect</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════ */}
      {/*  FIREWALL TAB                                       */}
      {/* ═══════════════════════════════════════════════════ */}

      {tab === 'firewall' && (
        <>
          {fwLoading ? (
            <p style={{ ...S.muted, marginTop: '1rem' }}>Loading firewall status…</p>
          ) : fwError ? (
            <div style={{ ...S.errorBar, marginTop: '1rem' }}>{fwError}</div>
          ) : fwStatus && (
            <>
              {/* Refresh button */}
              <div style={{ marginTop: '1rem', marginBottom: '0.75rem', display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={loadFirewall} style={S.btnSecondary}>↻ Refresh</button>
              </div>

              {/* Per-backend status cards */}
              {fwStatus.backends.map(be => (
                <div key={be.backend} style={{ ...S.card, marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: '0.95rem' }}>
                      {be.backend}: <span style={{ color: be.active ? 'var(--c-green)' : 'var(--c-red)', fontWeight: 700 }}>
                        {be.active ? 'Active' : 'Inactive'}
                      </span>
                    </h3>
                    {be.backend === fwStatus.primary && (
                      <span style={{ ...S.badgeOutline, borderColor: 'var(--c-purple)', color: 'var(--c-purple)' }}>primary</span>
                    )}
                    {be.details && <span style={{ ...S.muted, fontSize: '0.8rem' }}>{be.details}</span>}
                    <button
                      onClick={() => toggleFirewall(be.backend, be.active)}
                      style={be.active ? S.btnDanger : S.btnPrimary}
                    >
                      {be.active ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
              ))}

              {/* Add rule form */}
              {fwAvailableBackends.length > 0 && (
                <div style={{ ...S.card, marginTop: '0.75rem' }}>
                  <h3 style={S.cardTitle}>Add Rule</h3>
                  <div style={S.formRow}>
                    {fwAvailableBackends.length > 1 && (
                      <label style={S.formLabel}>
                        <span style={S.formLabelText}>Backend</span>
                        <select style={{ ...S.input, borderColor: ruleBackend ? 'var(--c-blue)' : 'var(--c-green)' }} value={ruleBackend} onChange={e => setRuleBackend(e.target.value)}>
                          {fwAvailableBackends.map(b => (
                            <option key={b} value={b}>{b}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {ruleBackend === 'firewalld' && (
                      <label style={S.formLabel}>
                        <span style={S.formLabelText}>Service</span>
                        <input style={{ ...S.input, borderColor: ruleService ? 'var(--c-blue)' : 'var(--c-green)' }} value={ruleService} onChange={e => setRuleService(e.target.value)}
                          placeholder="e.g. http, ssh" />
                      </label>
                    )}
                    <label style={S.formLabel}>
                      <span style={S.formLabelText}>Port</span>
                      <input style={{ ...S.input, width: 90, borderColor: rulePort ? 'var(--c-blue)' : 'var(--c-green)' }} value={rulePort} onChange={e => setRulePort(e.target.value)}
                        placeholder="e.g. 80" />
                    </label>
                    <label style={S.formLabel}>
                      <span style={S.formLabelText}>Protocol</span>
                      <select style={{ ...S.input, borderColor: ruleProto ? 'var(--c-blue)' : 'var(--c-green)' }} value={ruleProto} onChange={e => setRuleProto(e.target.value)}>
                        <option value="tcp">TCP</option>
                        <option value="udp">UDP</option>
                      </select>
                    </label>
                    {(ruleBackend === 'ufw' || ruleBackend === 'iptables' || ruleBackend === 'nftables') && (
                      <label style={S.formLabel}>
                        <span style={S.formLabelText}>Action</span>
                        <select style={{ ...S.input, borderColor: ruleAction ? 'var(--c-blue)' : 'var(--c-green)' }} value={ruleAction} onChange={e => setRuleAction(e.target.value)}>
                          <option value="allow">{ruleBackend === 'ufw' ? 'Allow' : 'Accept'}</option>
                          <option value="deny">{ruleBackend === 'ufw' ? 'Deny' : 'Drop'}</option>
                          <option value="reject">Reject</option>
                        </select>
                      </label>
                    )}
                    {ruleBackend === 'ufw' && (
                      <label style={S.formLabel}>
                        <span style={S.formLabelText}>From</span>
                        <input style={{ ...S.input, width: 120, borderColor: ruleFrom ? 'var(--c-blue)' : 'var(--c-green)' }} value={ruleFrom} onChange={e => setRuleFrom(e.target.value)}
                          placeholder="any" />
                      </label>
                    )}
                    <button onClick={addRule} style={{ ...S.btnPrimary, alignSelf: 'flex-end' }}>Add Rule</button>
                  </div>
                </div>
              )}

              {/* Rules table – grouped by backend */}
              <div style={{ ...S.card, marginTop: '0.75rem' }}>
                <h3 style={S.cardTitle}>Rules ({fwRules.length})</h3>
                {fwRules.length > 0 ? (
                  <table style={S.table}>
                    <thead>
                      <tr>
                        <th style={S.th}>#</th>
                        <th style={S.th}>Backend</th>
                        <th style={S.th}>Rule</th>
                        <th style={S.th}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fwRules.map((r, i) => (
                        <tr key={i} style={S.tr}>
                          <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-3)' }}>{r.number ?? i + 1}</td>
                          <td style={S.td}>
                            <span style={S.badgeOutline}>{r.backend || '?'}</span>
                          </td>
                          <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.82rem' }}>
                            {r.rule || r.value || r.raw || JSON.stringify(r)}
                            {r.type && <span style={{ ...S.badgeOutline, marginLeft: 8 }}>{r.type}</span>}
                            {r.zone && <span style={{ ...S.badgeOutline, marginLeft: 6 }}>{r.zone}</span>}
                          </td>
                          <td style={S.td}>
                            {['ufw', 'firewalld', 'iptables'].includes(r.backend || '') && (
                              <button onClick={() => removeRule(r)} style={S.btnDanger}>Remove</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p style={S.muted}>No rules configured</p>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════ */}
      {/*  INTERFACES TAB                                     */}
      {/* ═══════════════════════════════════════════════════ */}

      {tab === 'interfaces' && (
        <>
          {/* ── Interface table ── */}
          <div style={{ ...S.card, marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ ...S.cardTitle, marginBottom: 0 }}>All Interfaces</h3>
              <button onClick={loadInterfaces} style={S.btnSecondary}>↻ Refresh</button>
            </div>
            {ifaceLoading && interfaces.length === 0 ? (
              <p style={S.muted}>Loading…</p>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Interface</th>
                    <th style={S.th}>Type</th>
                    <th style={S.th}>State</th>
                    <th style={S.th}>MAC</th>
                    <th style={S.th}>IPv4</th>
                    <th style={S.th}>IPv6</th>
                    <th style={S.th}>MTU</th>
                    <th style={S.th}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {interfaces.map(iface => (
                    <tr key={iface.name} style={S.tr}>
                      <td style={{ ...S.td, fontWeight: 600 }}>
                        {ifaceIcon(iface.iface_type)} {iface.name}
                      </td>
                      <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{iface.iface_type}</td>
                      <td style={S.td}>
                        <span style={{ ...S.badge, background: stateColor(iface.state) }}>{iface.state}</span>
                      </td>
                      <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{iface.mac || '—'}</td>
                      <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{iface.ipv4.join(', ') || '—'}</td>
                      <td style={S.td}>
                        <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                          {iface.ipv6.length > 0 ? iface.ipv6.map((ip, i) => <span key={i}>{ip}</span>) : '—'}
                        </div>
                      </td>
                      <td style={{ ...S.td, fontSize: '0.8rem' }}>{iface.mtu}</td>
                      <td style={S.td}>
                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                          {iface.state === 'down' || iface.state === 'DOWN' ? (
                            <button onClick={() => ifaceAction('iface_up', iface.name)} style={S.btnSmallPrimary}>Up</button>
                          ) : (
                            <button onClick={() => ifaceAction('iface_down', iface.name)} style={S.btnSmallDanger}>Down</button>
                          )}
                          {(iface.iface_type === 'bridge' || iface.iface_type === 'vlan') && (
                            <button onClick={() => deleteInterface(iface.name)} style={S.btnSmallDanger}>Delete</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── Create Bridge ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.75rem' }}>
            <div style={S.card}>
              <h3 style={S.cardTitle}>Create Bridge</h3>
              <div style={S.formRow}>
                <label style={S.formLabel}>
                  <span style={S.formLabelText}>Bridge name</span>
                  <input style={{ ...S.input, borderColor: bridgeName ? 'var(--c-blue)' : 'var(--c-green)' }} value={bridgeName} onChange={e => setBridgeName(e.target.value)}
                    placeholder="e.g. br0" />
                </label>
                <button onClick={createBridge} style={{ ...S.btnPrimary, alignSelf: 'flex-end' }}>Create</button>
              </div>
            </div>

            {/* ── Create VLAN ── */}
            <div style={S.card}>
              <h3 style={S.cardTitle}>Create VLAN</h3>
              <div style={S.formRow}>
                <label style={S.formLabel}>
                  <span style={S.formLabelText}>Parent interface</span>
                  <select style={{ ...S.input, borderColor: vlanParent ? 'var(--c-blue)' : 'var(--c-green)' }} value={vlanParent} onChange={e => setVlanParent(e.target.value)}>
                    <option value="">Select…</option>
                    {interfaces.filter(i => i.iface_type === 'ethernet').map(i => (
                      <option key={i.name} value={i.name}>{i.name}</option>
                    ))}
                  </select>
                </label>
                <label style={S.formLabel}>
                  <span style={S.formLabelText}>VLAN ID</span>
                  <input style={{ ...S.input, width: 80, borderColor: vlanId ? 'var(--c-blue)' : 'var(--c-green)' }} value={vlanId} onChange={e => setVlanId(e.target.value)}
                    placeholder="1-4094" type="number" min={1} max={4094} />
                </label>
                <button onClick={createVlan} style={{ ...S.btnPrimary, alignSelf: 'flex-end' }}>Create</button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════ */}
      {/*  LOGS TAB                                           */}
      {/* ═══════════════════════════════════════════════════ */}

      {tab === 'logs' && (
        <>
          <div style={{ ...S.card, marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ ...S.cardTitle, marginBottom: 0 }}>Network Logs (NetworkManager / systemd-networkd)</h3>
              <button onClick={loadLogs} style={S.btnSecondary}>↻ Refresh</button>
            </div>
            {logsLoading ? (
              <p style={S.muted}>Loading logs…</p>
            ) : (
              <pre style={S.logPre}>
                {netLogs.length > 0 ? netLogs.join('\n') : 'No network logs available'}
              </pre>
            )}
          </div>

          <div style={{ ...S.card, marginTop: '0.75rem' }}>
            <h3 style={S.cardTitle}>Firewall Logs</h3>
            {fwLogs.length > 0 ? (
              <pre style={S.logPre}>{fwLogs.join('\n')}</pre>
            ) : (
              <p style={S.muted}>No firewall log entries</p>
            )}
          </div>
        </>
      )}
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
  tabBar: {
    display: 'flex',
    gap: '0.25rem',
    marginTop: '0.75rem',
    borderBottom: '1px solid var(--bg-surface)',
    paddingBottom: 0,
  },
  tabBtn: {
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--text-3)',
    padding: '0.6rem 1.1rem',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
    transition: 'color 0.15s, border-color 0.15s',
  },
  tabBtnActive: {
    color: 'var(--text-1)',
    borderBottomColor: 'var(--c-blue)',
  },

  chartsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '1rem',
    marginTop: '1rem',
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

  /* ── tables ── */
  table: { width: '100%', borderCollapse: 'collapse' as const },
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
  tr: { borderBottom: '1px solid var(--bg-surface)' },
  td: {
    padding: '0.55rem 0.75rem',
    fontSize: '0.85rem',
    verticalAlign: 'middle' as const,
  },

  /* ── interface cards ── */
  ifaceGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '0.75rem',
  },
  ifaceCard: {
    background: 'var(--bg-app)',
    borderRadius: 8,
    border: '1px solid var(--bg-surface)',
    overflow: 'hidden' as const,
  },
  ifaceHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.6rem 0.85rem',
    borderBottom: '1px solid var(--bg-surface)',
  },
  ifaceName: {
    fontWeight: 700,
    fontSize: '0.9rem',
    flex: 1,
    fontFamily: 'monospace',
  },
  ifaceType: {
    fontSize: '0.7rem',
    color: 'var(--text-3)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  ifaceBody: { padding: '0.5rem 0.85rem' },
  ifaceRow: {
    display: 'flex',
    gap: '0.5rem',
    padding: '0.15rem 0',
    fontSize: '0.82rem',
  },
  ifaceLabel: {
    color: 'var(--text-3)',
    minWidth: 40,
    fontWeight: 600,
    fontSize: '0.75rem',
    textTransform: 'uppercase' as const,
  },
  ifaceVal: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    wordBreak: 'break-all' as const,
  },

  badge: {
    padding: '0.15rem 0.5rem',
    borderRadius: 4,
    fontSize: '0.7rem',
    fontWeight: 600,
    color: 'var(--badge-fg)',
    textTransform: 'uppercase' as const,
  },
  badgeOutline: {
    padding: '0.15rem 0.5rem',
    borderRadius: 4,
    fontSize: '0.7rem',
    border: '1px solid var(--bg-surface)',
    color: 'var(--text-3)',
  },

  /* ── buttons ── */
  btnPrimary: {
    background: 'var(--c-blue)',
    color: 'var(--bg-app)',
    border: 'none',
    borderRadius: 6,
    padding: '0.4rem 1rem',
    fontWeight: 600,
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  btnSecondary: {
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    border: 'none',
    borderRadius: 6,
    padding: '0.4rem 1rem',
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  btnDanger: {
    background: 'var(--c-red)',
    color: 'var(--bg-app)',
    border: 'none',
    borderRadius: 6,
    padding: '0.35rem 0.85rem',
    fontWeight: 600,
    fontSize: '0.8rem',
    cursor: 'pointer',
  },
  btnSmallPrimary: {
    background: 'var(--c-blue)',
    color: 'var(--bg-app)',
    border: 'none',
    borderRadius: 4,
    padding: '0.2rem 0.6rem',
    fontWeight: 600,
    fontSize: '0.72rem',
    cursor: 'pointer',
  },
  btnSmallDanger: {
    background: 'var(--c-red)',
    color: 'var(--bg-app)',
    border: 'none',
    borderRadius: 4,
    padding: '0.2rem 0.6rem',
    fontWeight: 600,
    fontSize: '0.72rem',
    cursor: 'pointer',
  },

  /* ── forms ── */
  formRow: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'flex-end',
    flexWrap: 'wrap' as const,
  },
  formLabel: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.25rem',
  },
  formLabelText: {
    fontSize: '0.72rem',
    color: 'var(--text-3)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    fontWeight: 600,
  },
  input: {
    background: 'var(--bg-app)',
    border: '1px solid var(--c-green)',
    borderRadius: 6,
    color: 'var(--text-1)',
    padding: '0.4rem 0.65rem',
    fontSize: '0.85rem',
    outline: 'none',
  },

  /* ── error bar ── */
  errorBar: {
    background: 'color-mix(in srgb, var(--c-red) 8%, var(--bg-surface))',
    border: '1px solid var(--c-red)',
    borderRadius: 6,
    padding: '0.5rem 1rem',
    color: 'var(--c-red)',
    fontSize: '0.85rem',
    marginTop: '0.75rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  errorDismiss: {
    background: 'transparent',
    border: 'none',
    color: 'var(--c-red)',
    cursor: 'pointer',
    fontSize: '1rem',
    padding: '0 0.25rem',
  },

  /* ── overlay & modal ── */
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-app)',
    border: '1px solid var(--bg-surface)',
    borderRadius: 10,
    padding: '1.5rem',
    minWidth: 320,
  },

  /* ── logs ── */
  logPre: {
    background: 'var(--bg-app)',
    borderRadius: 6,
    padding: '0.85rem',
    fontSize: '0.78rem',
    fontFamily: 'monospace',
    maxHeight: 500,
    overflow: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    color: 'var(--text-1)',
    lineHeight: 1.5,
    border: '1px solid var(--bg-surface)',
  },
};
