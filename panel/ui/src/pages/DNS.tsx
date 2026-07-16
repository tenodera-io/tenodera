import { useEffect, useState, useCallback, useRef } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

interface DnsInfo {
  resolv_conf: string;
  hosts: string;
  servers: string[];
  search: string[];
  resolved_active: boolean;
}

type DnsTab = 'resolver' | 'hosts' | 'lookup' | 'resolved';

const QTYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'PTR', 'SOA', 'SRV'];

// ── Main component ─────────────────────────────────────────────────────────────

export function DNS() {
  const { request } = useTransport();
  const su = useSuperuser();
  const [activeTab, setActiveTab] = useTabParam<DnsTab>(['resolver', 'hosts', 'lookup', 'resolved'], 'resolver');
  const [info, setInfo] = useState<DnsInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [data] = await request('dns.info', {});
      if (data) setInfo(data as DnsInfo);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <PageHeader icon="dns" title="DNS" />

      <Tabs
        tabs={[
          { id: 'resolver', label: 'Resolver' },
          { id: 'hosts', label: '/etc/hosts' },
          { id: 'lookup', label: 'Lookup' },
          { id: 'resolved', label: 'systemd-resolved' },
        ]}
        active={activeTab}
        onChange={(t) => setActiveTab(t as DnsTab)}
        style={{ marginBottom: '1.25rem' }}
      />

      {loading && !info ? (
        <p style={S.muted}>Loading…</p>
      ) : activeTab === 'resolver' ? (
        <ResolverTab info={info} su={su} request={request} onReload={reload} />
      ) : activeTab === 'hosts' ? (
        <EtcHostsTab info={info} su={su} request={request} onReload={reload} />
      ) : activeTab === 'lookup' ? (
        <LookupTab request={request} />
      ) : (
        <ResolvedTab su={su} request={request} />
      )}
    </div>
  );
}

// ── Resolver tab ───────────────────────────────────────────────────────────────

function ResolverTab({ info, su, request, onReload }: {
  info: DnsInfo | null;
  su: ReturnType<typeof useSuperuser>;
  request: ReturnType<typeof useTransport>['request'];
  onReload: () => void;
}) {
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [msg, setMsg] = useState('');
  const [pwPrompt, setPwPrompt] = useState<string | null>(null);
  const [pw, setPw] = useState('');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  const openEdit = () => {
    setEditContent(info?.resolv_conf ?? '');
    setEditMode(true);
  };

  const saveResolvConf = async (password: string) => {
    setSaving(true);
    try {
      const [r] = await request('dns.manage', { action: 'set_resolv_conf', content: editContent, password });
      const res = r as { ok?: boolean; error?: string };
      if (res?.ok) { flash('✓ Saved'); setEditMode(false); onReload(); }
      else flash(res?.error ?? 'Failed');
    } catch (e) { flash(String(e)); }
    finally { setSaving(false); }
  };

  const flushCache = async (password: string) => {
    setFlushing(true);
    try {
      const [r] = await request('dns.manage', { action: 'flush_cache', password });
      const res = r as { ok?: boolean; error?: string };
      flash(res?.ok ? '✓ Cache flushed' : (res?.error ?? 'Failed'));
    } catch (e) { flash(String(e)); }
    finally { setFlushing(false); }
  };

  const handleSave = () => {
    if (su.active) { saveResolvConf(su.password); return; }
    setPwPrompt('save'); setPw('');
  };

  const handleFlush = () => {
    if (!info?.resolved_active) { flash('systemd-resolved is not active'); return; }
    if (su.active) { flushCache(su.password); return; }
    setPwPrompt('flush'); setPw('');
  };

  const confirmPw = () => {
    if (!pw) return;
    if (pwPrompt === 'save') saveResolvConf(pw);
    else if (pwPrompt === 'flush') flushCache(pw);
    setPwPrompt(null); setPw('');
  };

  if (!info) return <p style={S.muted}>No data.</p>;

  return (
    <div style={S.section}>
      {/* Status row */}
      <div style={S.statusRow}>
        <span style={S.sectionLabel}>systemd-resolved</span>
        <span style={{ ...S.badge, color: 'var(--badge-fg)', background: info.resolved_active ? 'var(--c-green)' : 'var(--text-3)' }}>
          {info.resolved_active ? 'active' : 'inactive'}
        </span>
        {info.resolved_active && (
          <button style={S.actionBtn} onClick={handleFlush} disabled={flushing}>
            {flushing ? '…' : '↺ Flush cache'}
          </button>
        )}
        {msg && <span style={{ fontSize: '0.8rem', color: msg.startsWith('✓') ? 'var(--c-green)' : 'var(--c-red)' }}>{msg}</span>}
      </div>

      {/* Nameservers */}
      <div style={S.card}>
        <div style={S.cardTitle}>Nameservers</div>
        {info.servers.length === 0 ? (
          <span style={S.muted}>None configured</span>
        ) : (
          <div style={S.serverList}>
            {info.servers.map((s) => (
              <span key={s} style={S.serverChip}>{s}</span>
            ))}
          </div>
        )}
      </div>

      {/* Search domains */}
      {info.search.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Search domains</div>
          <div style={S.serverList}>
            {info.search.map((d) => (
              <span key={d} style={S.domainChip}>{d}</span>
            ))}
          </div>
        </div>
      )}

      {/* resolv.conf editor */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <div style={S.cardTitle}>/etc/resolv.conf</div>
          {!editMode && (
            <button style={S.editBtn} onClick={openEdit}>Edit</button>
          )}
        </div>

        {editMode ? (
          <>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              style={S.textarea}
              rows={12}
              spellCheck={false}
            />
            <div style={S.btnRow}>
              <button style={S.saveBtn} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button style={S.cancelBtn} onClick={() => setEditMode(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <pre style={S.pre}>{info.resolv_conf || '(empty)'}</pre>
        )}
      </div>

      {/* Password prompt */}
      {pwPrompt && (
        <div style={S.pwBar}>
          <span style={S.muted}>Password required:</span>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setPwPrompt(null); setPw(''); } }}
            autoFocus
            style={S.pwInput}
            placeholder="sudo password…"
          />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setPwPrompt(null); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── Hosts tab ──────────────────────────────────────────────────────────────────

function EtcHostsTab({ info, su, request, onReload }: {
  info: DnsInfo | null;
  su: ReturnType<typeof useSuperuser>;
  request: ReturnType<typeof useTransport>['request'];
  onReload: () => void;
}) {
  const [content, setContent] = useState(info?.hosts ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [pwPrompt, setPwPrompt] = useState(false);
  const [pw, setPw] = useState('');

  useEffect(() => { if (info) setContent(info.hosts); }, [info]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  const saveHosts = async (password: string) => {
    setSaving(true);
    try {
      const [r] = await request('dns.manage', { action: 'set_hosts', content, password });
      const res = r as { ok?: boolean; error?: string };
      if (res?.ok) { flash('✓ Saved'); onReload(); }
      else flash(res?.error ?? 'Failed');
    } catch (e) { flash(String(e)); }
    finally { setSaving(false); }
  };

  const handleSave = () => {
    if (su.active) { saveHosts(su.password); return; }
    setPwPrompt(true); setPw('');
  };

  const confirmPw = () => {
    if (!pw) return;
    saveHosts(pw);
    setPwPrompt(false); setPw('');
  };

  const lines = content.split('\n').length;
  const changed = content !== (info?.hosts ?? '');

  return (
    <div style={S.section}>
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
          <div style={S.cardTitle}>/etc/hosts <span style={S.muted}>({lines} lines)</span></div>
          {msg && <span style={{ fontSize: '0.8rem', color: msg.startsWith('✓') ? 'var(--c-green)' : 'var(--c-red)' }}>{msg}</span>}
        </div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{ ...S.textarea, minHeight: 360 }}
          rows={20}
          spellCheck={false}
        />
        <div style={S.btnRow}>
          <button
            style={{ ...S.saveBtn, opacity: changed ? 1 : 0.4, cursor: changed ? 'pointer' : 'default' }}
            onClick={handleSave}
            disabled={!changed || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {changed && (
            <button style={S.cancelBtn} onClick={() => setContent(info?.hosts ?? '')}>Revert</button>
          )}
        </div>
      </div>

      {pwPrompt && (
        <div style={S.pwBar}>
          <span style={S.muted}>Password required:</span>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setPwPrompt(false); setPw(''); } }}
            autoFocus
            style={S.pwInput}
            placeholder="sudo password…"
          />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setPwPrompt(false); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── Lookup tab ─────────────────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function LookupTab({ request }: { request: ReturnType<typeof useTransport>['request'] }) {
  const [name, setName] = useState('');
  const [qtype, setQtype] = useState('A');
  const [output, setOutput] = useState('');
  const [looking, setLooking] = useState(false);
  const [ok, setOk] = useState(true);
  const [frame, setFrame] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (looking) {
      timerRef.current = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [looking]);

  const doLookup = async () => {
    if (!name.trim()) return;
    setLooking(true);
    setOutput('');
    try {
      const [r] = await request('dns.lookup', { name: name.trim(), qtype });
      const res = r as { ok?: boolean; output?: string };
      setOk(res?.ok !== false);
      setOutput(res?.output ?? '(no response)');
    } catch (e) {
      setOk(false);
      setOutput(String(e));
    } finally {
      setLooking(false);
    }
  };

  return (
    <div style={S.section}>
      <div style={S.card}>
        <div style={S.cardTitle}>DNS Lookup</div>
        <div style={S.lookupRow}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doLookup(); }}
            placeholder="Hostname or IP…"
            style={S.lookupInput}
          />
          <select value={qtype} onChange={(e) => setQtype(e.target.value)} style={S.typeSelect}>
            {QTYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button style={S.lookupBtn} onClick={doLookup} disabled={looking || !name.trim()}>
            Lookup
          </button>
        </div>

        {looking && (
          <div style={S.spinnerRow}>
            <span style={S.spinnerChar}>{SPINNER[frame]}</span>
            <span style={S.muted}>Querying {name} {qtype}…</span>
          </div>
        )}

        {output && (
          <pre style={{ ...S.pre, marginTop: '1rem', color: ok ? 'var(--text-1)' : 'var(--c-red)' }}>
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── systemd-resolved tab ───────────────────────────────────────────────────────

interface ResolvedConf {
  has_user_conf: boolean;
  dns: string; fallback_dns: string; domains: string;
  dnssec: string; dns_over_tls: string; cache: string;
  llmnr: string; mdns: string;
}

interface ResolvedInfo {
  active: boolean;
  has_resolvectl: boolean;
  mode: string;
  current_dns: string;
  dns_servers: string[];
  fallback_dns: string[];
  dns_domain: string;
  dnssec: string;
  dns_over_tls: string;
  llmnr: string;
  mdns: string;
  links: { name: string; current_dns: string; dns_servers: string[]; dns_domain: string }[];
  stat_transactions: number;
  stat_hits: number;
  stat_misses: number;
  conf: ResolvedConf;
}

const DNSSEC_OPTS   = ['', 'yes', 'no', 'allow-downgrade'];
const DOT_OPTS      = ['', 'yes', 'no', 'opportunistic'];
const CACHE_OPTS    = ['', 'yes', 'no', 'no-negative'];
const TOGGLE_OPTS   = ['', 'yes', 'no', 'resolve'];

function ResolvedTab({ su, request }: {
  su: ReturnType<typeof useSuperuser>;
  request: ReturnType<typeof useTransport>['request'];
}) {
  const [info, setInfo] = useState<ResolvedInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [conf, setConf] = useState<ResolvedConf | null>(null);
  const [msg, setMsg] = useState('');
  const [pwPrompt, setPwPrompt] = useState<string | null>(null);
  const [pw, setPw] = useState('');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 5000); };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [data] = await request('dns.resolved.info', {});
      const d = data as ResolvedInfo;
      setInfo(d);
      setConf({ ...d.conf });
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { reload(); }, [reload]);

  const execAction = async (action: string, password: string, extra?: Record<string, unknown>) => {
    try {
      const [r] = await request('dns.resolved.manage', { action, password, ...extra });
      const res = r as { ok?: boolean; error?: string };
      if (res?.ok) { flash('✓ Done'); reload(); }
      else flash(res?.error ?? 'Failed');
    } catch (e) { flash(String(e)); }
  };

  const handleAction = (action: string, extra?: Record<string, unknown>) => {
    if (su.active) { execAction(action, su.password, extra); return; }
    setPwPrompt(action); setPw('');
  };

  const handleSaveConf = () => {
    if (!conf) return;
    handleAction('set_config', {
      dns: conf.dns, fallback_dns: conf.fallback_dns, domains: conf.domains,
      dnssec: conf.dnssec, dns_over_tls: conf.dns_over_tls,
      cache: conf.cache, llmnr: conf.llmnr, mdns: conf.mdns,
    });
  };

  const confirmPw = () => {
    if (!pw || !pwPrompt) return;
    const action = pwPrompt;
    setPwPrompt(null); setPw('');
    if (action === 'set_config' && conf) {
      execAction(action, pw, {
        dns: conf.dns, fallback_dns: conf.fallback_dns, domains: conf.domains,
        dnssec: conf.dnssec, dns_over_tls: conf.dns_over_tls,
        cache: conf.cache, llmnr: conf.llmnr, mdns: conf.mdns,
      });
    } else {
      execAction(action, pw);
    }
  };

  if (loading && !info) return <p style={S.muted}>Loading…</p>;
  if (!info) return <p style={S.muted}>No data.</p>;

  const hitRate = info.stat_hits + info.stat_misses > 0
    ? Math.round(info.stat_hits / (info.stat_hits + info.stat_misses) * 100)
    : null;

  return (
    <div style={S.section}>
      {/* Service status */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span style={S.cardTitle}>systemd-resolved</span>
          <span style={{ ...S.badge, color: 'var(--badge-fg)', background: info.active ? 'var(--c-green)' : 'var(--text-3)' }}>
            {info.active ? 'active' : 'inactive'}
          </span>
          {info.active && (
            <>
              <span style={{ ...S.badge, background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)', color: 'var(--c-blue)' }}>
                {info.mode ? `resolv.conf: ${info.mode}` : ''}
              </span>
              <button style={S.actionBtn} onClick={() => handleAction('flush_caches')}>↺ Flush cache</button>
              <button style={{ ...S.actionBtn, color: 'var(--c-red)' }} onClick={() => handleAction('stop')}>Stop</button>
            </>
          )}
          {!info.active && (
            <button style={{ ...S.actionBtn, color: 'var(--c-green)' }} onClick={() => handleAction('start')}>Start</button>
          )}
          {msg && <span style={{ fontSize: '0.8rem', color: msg.startsWith('✓') ? 'var(--c-green)' : 'var(--c-red)' }}>{msg}</span>}
        </div>

        {/* Runtime status badges */}
        {info.active && (info.dnssec || info.dns_over_tls || info.llmnr || info.mdns) && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            {info.dnssec && <ProtoBadge label="DNSSEC" value={info.dnssec} />}
            {info.dns_over_tls && <ProtoBadge label="DoT" value={info.dns_over_tls} />}
            {info.llmnr && <ProtoBadge label="LLMNR" value={info.llmnr} />}
            {info.mdns && <ProtoBadge label="mDNS" value={info.mdns} />}
          </div>
        )}

        {/* Global DNS servers */}
        {info.active && info.dns_servers.length > 0 && (
          <div style={{ marginTop: '0.75rem' }}>
            <span style={S.statusLabel}>DNS servers: </span>
            {info.dns_servers.map(s => <span key={s} style={S.serverChip}>{s}</span>)}
            {info.fallback_dns.length > 0 && (
              <> <span style={S.statusLabel}> fallback: </span>
                {info.fallback_dns.map(s => <span key={s} style={S.domainChip}>{s}</span>)}
              </>
            )}
          </div>
        )}
      </div>

      {/* Per-link table */}
      {info.active && info.links.length > 0 && (
        <div style={S.card}>
          <div style={S.cardTitle}>Network interfaces</div>
          <table style={{ ...S.table, marginTop: '0.25rem' }}>
            <thead>
              <tr>
                <th style={S.th}>Interface</th>
                <th style={S.th}>Current DNS</th>
                <th style={S.th}>DNS Servers</th>
                <th style={S.th}>Domain</th>
              </tr>
            </thead>
            <tbody>
              {info.links.map(l => (
                <tr key={l.name}>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 600 }}>{l.name}</td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{l.current_dns || '—'}</td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{l.dns_servers.join(' ') || '—'}</td>
                  <td style={{ ...S.td, fontSize: '0.8rem', color: 'var(--text-2)' }}>{l.dns_domain || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Configuration editor */}
      {conf && (
        <div style={S.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={S.cardTitle}>/etc/systemd/resolved.conf</div>
            {!info.conf.has_user_conf && (
              <span style={{ fontSize: '0.75rem', color: 'var(--c-yellow)' }}>using system defaults — saving creates /etc/systemd/resolved.conf</span>
            )}
          </div>

          <div style={S.confGrid}>
            <ConfField label="DNS servers" hint="space-separated IPs">
              <input style={S.confInput} value={conf.dns} onChange={e => setConf(c => c && ({ ...c, dns: e.target.value }))} placeholder="1.1.1.1 8.8.8.8" spellCheck={false} />
            </ConfField>
            <ConfField label="Fallback DNS" hint="space-separated IPs">
              <input style={S.confInput} value={conf.fallback_dns} onChange={e => setConf(c => c && ({ ...c, fallback_dns: e.target.value }))} placeholder="8.8.8.8 8.8.4.4" spellCheck={false} />
            </ConfField>
            <ConfField label="Domains" hint="search/routing domains">
              <input style={S.confInput} value={conf.domains} onChange={e => setConf(c => c && ({ ...c, domains: e.target.value }))} placeholder="~. example.com" spellCheck={false} />
            </ConfField>
            <ConfField label="DNSSEC" hint="yes / no / allow-downgrade">
              <select style={S.confSelect} value={conf.dnssec} onChange={e => setConf(c => c && ({ ...c, dnssec: e.target.value }))}>
                {DNSSEC_OPTS.map(o => <option key={o} value={o}>{o || '(default)'}</option>)}
              </select>
            </ConfField>
            <ConfField label="DNS over TLS" hint="yes / no / opportunistic">
              <select style={S.confSelect} value={conf.dns_over_tls} onChange={e => setConf(c => c && ({ ...c, dns_over_tls: e.target.value }))}>
                {DOT_OPTS.map(o => <option key={o} value={o}>{o || '(default)'}</option>)}
              </select>
            </ConfField>
            <ConfField label="Cache" hint="yes / no / no-negative">
              <select style={S.confSelect} value={conf.cache} onChange={e => setConf(c => c && ({ ...c, cache: e.target.value }))}>
                {CACHE_OPTS.map(o => <option key={o} value={o}>{o || '(default)'}</option>)}
              </select>
            </ConfField>
            <ConfField label="LLMNR" hint="yes / no / resolve">
              <select style={S.confSelect} value={conf.llmnr} onChange={e => setConf(c => c && ({ ...c, llmnr: e.target.value }))}>
                {TOGGLE_OPTS.map(o => <option key={o} value={o}>{o || '(default)'}</option>)}
              </select>
            </ConfField>
            <ConfField label="Multicast DNS" hint="yes / no / resolve">
              <select style={S.confSelect} value={conf.mdns} onChange={e => setConf(c => c && ({ ...c, mdns: e.target.value }))}>
                {TOGGLE_OPTS.map(o => <option key={o} value={o}>{o || '(default)'}</option>)}
              </select>
            </ConfField>
          </div>

          <div style={S.btnRow}>
            <button style={S.saveBtn} onClick={handleSaveConf}>
              Save & Reload
            </button>
            <button style={S.cancelBtn} onClick={reload}>Reset</button>
          </div>
        </div>
      )}

      {/* Cache statistics */}
      {info.active && (info.stat_transactions > 0 || info.stat_hits > 0) && (
        <div style={S.card}>
          <div style={S.cardTitle}>Cache statistics</div>
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
            <StatItem label="Transactions" value={info.stat_transactions} />
            <StatItem label="Cache hits" value={info.stat_hits} />
            <StatItem label="Cache misses" value={info.stat_misses} />
            {hitRate !== null && <StatItem label="Hit rate" value={`${hitRate}%`} />}
          </div>
        </div>
      )}

      {/* Password prompt */}
      {pwPrompt && (
        <div style={S.pwBar}>
          <span style={S.muted}>Password required for <b>{pwPrompt}</b>:</span>
          <input
            type="password" value={pw}
            onChange={e => setPw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmPw(); if (e.key === 'Escape') { setPwPrompt(null); setPw(''); } }}
            autoFocus style={S.pwInput} placeholder="sudo password…"
          />
          <button style={S.saveBtn} onClick={confirmPw} disabled={!pw}>Confirm</button>
          <button style={S.cancelBtn} onClick={() => { setPwPrompt(null); setPw(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function ConfField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
      <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </label>
      {children}
      {hint && <span style={{ fontSize: '0.7rem', color: 'var(--text-2)' }}>{hint}</span>}
    </div>
  );
}

function ProtoBadge({ label, value }: { label: string; value: string }) {
  const on = value === 'yes' || value === 'resolve' || value === 'opportunistic' || value === 'allow-downgrade';
  const color = on ? 'var(--c-green)' : (value === 'no' ? 'var(--text-3)' : 'var(--c-yellow)');
  return (
    <span style={{ ...S.badge, color: 'var(--badge-fg)', background: color, fontSize: '0.75rem' }}>
      {label}: {value}
    </span>
  );
}

function StatItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginBottom: '0.2rem' }}>{label}</div>
      <div style={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex',
    gap: '0.25rem',
    borderBottom: '1px solid var(--border)',
    marginBottom: '1.25rem',
  },
  tab: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-2)',
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
    color: 'var(--c-blue)',
    borderBottom: '2px solid var(--c-blue)',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  card: {
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1rem',
  },
  cardTitle: {
    fontSize: '0.8rem',
    fontWeight: 700,
    color: 'var(--text-2)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '0.6rem',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexWrap: 'wrap',
    marginBottom: '0.25rem',
  },
  sectionLabel: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: 'var(--text-2)',
  },
  badge: {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: 4,
    fontSize: '0.8rem',
    fontWeight: 600,
  },
  serverList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.4rem',
  },
  serverChip: {
    fontFamily: 'monospace',
    fontSize: '0.9rem',
    background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)',
    color: 'var(--c-blue)',
    border: '1px solid color-mix(in srgb, var(--c-blue) 20%, transparent)',
    borderRadius: 5,
    padding: '0.2rem 0.7rem',
  },
  domainChip: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    background: 'color-mix(in srgb, var(--c-yellow) 13%, transparent)',
    color: 'var(--c-yellow)',
    border: '1px solid color-mix(in srgb, var(--c-yellow) 20%, transparent)',
    borderRadius: 5,
    padding: '0.2rem 0.7rem',
  },
  pre: {
    margin: 0,
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--text-1)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    padding: '0.75rem',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    color: 'var(--text-1)',
    padding: '0.75rem',
    resize: 'vertical',
    outline: 'none',
    lineHeight: 1.5,
  },
  btnRow: {
    display: 'flex',
    gap: '0.5rem',
    marginTop: '0.75rem',
  },
  saveBtn: {
    padding: '0.35rem 0.9rem',
    borderRadius: 5,
    border: '1px solid color-mix(in srgb, var(--c-green) 40%, transparent)',
    background: 'color-mix(in srgb, var(--c-green) 13%, transparent)',
    color: 'var(--c-green)',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  cancelBtn: {
    padding: '0.35rem 0.9rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-2)',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  editBtn: {
    padding: '0.2rem 0.7rem',
    borderRadius: 4,
    border: '1px solid color-mix(in srgb, var(--c-blue) 40%, transparent)',
    background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)',
    color: 'var(--c-blue)',
    cursor: 'pointer',
    fontSize: '0.78rem',
  },
  actionBtn: {
    padding: '0.25rem 0.7rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--c-blue)',
    cursor: 'pointer',
    fontSize: '0.82rem',
  },
  pwBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '0.75rem 1rem',
  },
  pwInput: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid color-mix(in srgb, var(--c-blue) 40%, transparent)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    width: 200,
    outline: 'none',
  },
  lookupRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  lookupInput: {
    flex: 1,
    minWidth: 200,
    padding: '0.45rem 0.65rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.9rem',
    fontFamily: 'monospace',
    outline: 'none',
  },
  typeSelect: {
    padding: '0.4rem 0.5rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  lookupBtn: {
    padding: '0.4rem 1rem',
    borderRadius: 5,
    border: '1px solid color-mix(in srgb, var(--c-blue) 40%, transparent)',
    background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)',
    color: 'var(--c-blue)',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  muted: {
    color: 'var(--text-2)',
    fontSize: '0.85rem',
  },
  spinnerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginTop: '0.75rem',
  },
  spinnerChar: {
    fontFamily: 'monospace',
    fontSize: '1rem',
    color: 'var(--c-blue)',
  },
  statusLabel: {
    fontSize: '0.82rem',
    color: 'var(--text-2)',
    fontWeight: 500,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    fontSize: '0.75rem',
    fontWeight: 700,
    color: 'var(--text-2)',
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    padding: '0.3rem 0.6rem',
    borderBottom: '1px solid var(--border)',
  },
  td: {
    padding: '0.4rem 0.6rem',
    borderBottom: '1px solid var(--border)',
    fontSize: '0.88rem',
  },
  confGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '0.75rem',
    marginBottom: '0.5rem',
  },
  confInput: {
    padding: '0.35rem 0.55rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    fontFamily: 'monospace',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  confSelect: {
    padding: '0.35rem 0.55rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-1)',
    fontSize: '0.85rem',
    cursor: 'pointer',
    width: '100%',
    boxSizing: 'border-box',
  },
};
