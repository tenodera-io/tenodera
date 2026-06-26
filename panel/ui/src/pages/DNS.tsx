import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';

// ── Types ──────────────────────────────────────────────────────────────────────

interface DnsInfo {
  resolv_conf: string;
  hosts: string;
  servers: string[];
  search: string[];
  resolved_active: boolean;
}

type DnsTab = 'resolver' | 'hosts' | 'lookup';

const QTYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'PTR', 'SOA', 'SRV'];

// ── Main component ─────────────────────────────────────────────────────────────

export function DNS() {
  const { request } = useTransport();
  const su = useSuperuser();
  const [activeTab, setActiveTab] = useState<DnsTab>('resolver');
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
      <h2>DNS</h2>

      <div style={S.tabBar}>
        {(['resolver', 'hosts', 'lookup'] as DnsTab[]).map((t) => (
          <button
            key={t}
            style={activeTab === t ? S.tabActive : S.tab}
            onClick={() => setActiveTab(t)}
          >
            {t === 'resolver' ? 'Resolver' : t === 'hosts' ? '/etc/hosts' : 'Lookup'}
          </button>
        ))}
      </div>

      {loading && !info ? (
        <p style={S.muted}>Loading…</p>
      ) : activeTab === 'resolver' ? (
        <ResolverTab info={info} su={su} request={request} onReload={reload} />
      ) : activeTab === 'hosts' ? (
        <HostsTab info={info} su={su} request={request} onReload={reload} />
      ) : (
        <LookupTab request={request} />
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
        <span style={{ ...S.badge, color: info.resolved_active ? '#9ece6a' : '#565f89', background: (info.resolved_active ? '#9ece6a' : '#565f89') + '22' }}>
          {info.resolved_active ? 'active' : 'inactive'}
        </span>
        {info.resolved_active && (
          <button style={S.actionBtn} onClick={handleFlush} disabled={flushing}>
            {flushing ? '…' : '↺ Flush cache'}
          </button>
        )}
        {msg && <span style={{ fontSize: '0.8rem', color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e' }}>{msg}</span>}
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

function HostsTab({ info, su, request, onReload }: {
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
          {msg && <span style={{ fontSize: '0.8rem', color: msg.startsWith('✓') ? '#9ece6a' : '#f7768e' }}>{msg}</span>}
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

function LookupTab({ request }: { request: ReturnType<typeof useTransport>['request'] }) {
  const [name, setName] = useState('');
  const [qtype, setQtype] = useState('A');
  const [output, setOutput] = useState('');
  const [looking, setLooking] = useState(false);
  const [ok, setOk] = useState(true);

  const doLookup = async () => {
    if (!name.trim()) return;
    setLooking(true);
    setOutput('');
    try {
      const [r] = await request('dns.lookup', { name: name.trim(), type: qtype });
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
            {looking ? '…' : 'Lookup'}
          </button>
        </div>

        {output && (
          <pre style={{ ...S.pre, marginTop: '1rem', color: ok ? 'var(--text-primary)' : '#f7768e' }}>
            {output}
          </pre>
        )}
      </div>
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
    padding: '0.4rem 1.1rem',
    border: '1px solid transparent',
    borderBottom: 'none',
    borderRadius: '6px 6px 0 0',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 500,
    position: 'relative',
    bottom: -1,
  },
  tabActive: {
    padding: '0.4rem 1.1rem',
    border: '1px solid var(--border)',
    borderBottom: '1px solid var(--bg-primary)',
    borderRadius: '6px 6px 0 0',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: '0.9rem',
    fontWeight: 600,
    position: 'relative',
    bottom: -1,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1rem',
  },
  cardTitle: {
    fontSize: '0.8rem',
    fontWeight: 700,
    color: 'var(--text-secondary)',
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
    color: 'var(--text-secondary)',
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
    background: '#7aa2f722',
    color: '#7aa2f7',
    border: '1px solid #7aa2f733',
    borderRadius: 5,
    padding: '0.2rem 0.7rem',
  },
  domainChip: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    background: '#e0af6822',
    color: '#e0af68',
    border: '1px solid #e0af6833',
    borderRadius: 5,
    padding: '0.2rem 0.7rem',
  },
  pre: {
    margin: 0,
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--text-primary)',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    padding: '0.75rem',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    color: 'var(--text-primary)',
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
    border: '1px solid #9ece6a66',
    background: '#9ece6a22',
    color: '#9ece6a',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  cancelBtn: {
    padding: '0.35rem 0.9rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  editBtn: {
    padding: '0.2rem 0.7rem',
    borderRadius: 4,
    border: '1px solid #7aa2f766',
    background: '#7aa2f722',
    color: '#7aa2f7',
    cursor: 'pointer',
    fontSize: '0.78rem',
  },
  actionBtn: {
    padding: '0.25rem 0.7rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: '#7aa2f7',
    cursor: 'pointer',
    fontSize: '0.82rem',
  },
  pwBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '0.75rem 1rem',
  },
  pwInput: {
    padding: '0.3rem 0.5rem',
    borderRadius: 4,
    border: '1px solid #7aa2f766',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
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
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.9rem',
    fontFamily: 'monospace',
    outline: 'none',
  },
  typeSelect: {
    padding: '0.4rem 0.5rem',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  lookupBtn: {
    padding: '0.4rem 1rem',
    borderRadius: 5,
    border: '1px solid #7aa2f766',
    background: '#7aa2f722',
    color: '#7aa2f7',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 500,
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
  },
};
