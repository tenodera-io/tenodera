import React, { useEffect, useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface HostEntry {
  id: string;
  name: string;
  hostname: string;
  display_name: string | null;
  added_at: string;
  last_seen: string | null;
  online: boolean;
  is_local: boolean;
  remote_ip: string | null;
}

interface PendingEntry {
  hostname: string;
  fingerprint: string;
  fingerprint_hex: string;
  remote_ip: string;
  waiting_secs: number;
}

interface TokenEntry {
  id: string;
  single_use: boolean;
  use_count: number;
  max_uses: number | null;
  expires_in_secs: number;
  bound_hostname: string | null;
  re_enroll: boolean;
  expired: boolean;
  exhausted: boolean;
}

interface HostsProps {
  onClose: () => void;
  onChange?: () => void;
}

type Tab = 'enrolled' | 'pending' | 'tokens';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionToken(): string {
  return sessionStorage.getItem('session_id') ?? '';
}

async function apiFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken()}`,
      ...(init?.headers ?? {}),
    },
  });
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtSecs(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ── Main component ────────────────────────────────────────────────────────────

export function Hosts({ onClose, onChange }: HostsProps) {
  const [tab, setTab] = useState<Tab>('enrolled');
  const [pendingCount, setPendingCount] = useState(0);

  return (
    <div>
      <div style={S.header}>
        <h2 style={S.title}>Hosts</h2>
        <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          {(['enrolled', 'pending', 'tokens'] as Tab[]).map(t => (
            <button
              key={t}
              style={{ ...S.tabBtn, ...(tab === t ? S.tabActive : {}) }}
              onClick={() => setTab(t)}
            >
              {t === 'enrolled' ? 'Enrolled' : t === 'pending'
                ? `Pending${pendingCount > 0 ? ` (${pendingCount})` : ''}`
                : 'Tokens'}
            </button>
          ))}
          <button style={S.iconBtn} onClick={onClose} title="Close">&#x2715;</button>
        </div>
      </div>

      {tab === 'enrolled' && (
        <EnrolledTab onChange={onChange} />
      )}
      {tab === 'pending' && (
        <PendingTab onCountChange={setPendingCount} onChange={onChange} />
      )}
      {tab === 'tokens' && (
        <TokensTab />
      )}
    </div>
  );
}

// ── Enrolled tab ─────────────────────────────────────────────────────────────

function EnrolledTab({ onChange }: { onChange?: () => void }) {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/hosts');
      if (res.ok) {
        const data = await res.json();
        setHosts(data.hosts ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (id: string) => {
    await apiFetch(`/api/hosts/${id}`, { method: 'DELETE' });
    await load();
    onChange?.();
  };

  const startEdit = (h: HostEntry) => {
    setEditingId(h.id);
    setEditValue(h.display_name ?? h.name);
  };

  const cancelEdit = () => { setEditingId(null); setEditValue(''); };

  const saveEdit = async (id: string) => {
    const trimmed = editValue.trim();
    await apiFetch(`/api/hosts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: trimmed || null }),
    });
    setEditingId(null);
    await load();
    onChange?.();
  };

  if (loading) return <div style={S.empty}>Loading...</div>;

  if (hosts.length === 0) return (
    <div style={S.empty}>
      <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>&#128421;&#65039;</div>
      <div style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>
        No enrolled hosts yet. Install the agent on a remote host and approve it in Pending.
      </div>
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
        <button style={S.iconBtn} onClick={load} title="Refresh">&#x21BB;</button>
      </div>
      <div style={S.list}>
        {hosts.map(h => {
          const label = h.display_name ?? h.name;
          const isEditing = editingId === h.id;
          const showHostname = h.hostname && h.hostname !== label;
          return (
            <div key={h.id} style={S.row}>
              <div style={{ ...S.dot, background: h.online ? 'var(--c-green)' : 'var(--text-3)' }}
                title={h.online ? 'Online' : 'Offline'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {isEditing ? (
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                    <input
                      style={S.editInput}
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveEdit(h.id);
                        if (e.key === 'Escape') cancelEdit();
                      }}
                      autoFocus
                    />
                    <button style={S.saveBtn} onClick={() => saveEdit(h.id)}>Save</button>
                    <button style={S.cancelBtn} onClick={cancelEdit}>&#x2715;</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={S.hostLabel}>{label}</span>
                    <button style={S.editBtn} onClick={() => startEdit(h)} title="Rename">&#x270E;</button>
                  </div>
                )}
                <div style={S.meta}>
                  {showHostname && <span style={S.metaChip}>{h.hostname}</span>}
                  {h.is_local && <span style={{ ...S.metaChip, color: 'var(--c-blue)' }}>local</span>}
                  {h.remote_ip && <span style={{ ...S.metaChip, fontFamily: 'monospace' }}>{h.remote_ip}</span>}
                  {h.online
                    ? <span style={{ color: 'var(--c-green)' }}>online</span>
                    : <span>last seen: {h.last_seen ? timeAgo(h.last_seen) : 'never'}</span>
                  }
                  <span style={S.metaDot}>·</span>
                  <span>added {new Date(h.added_at).toLocaleDateString()}</span>
                </div>
              </div>
              {!h.is_local && (
                <button style={S.removeBtn} onClick={() => remove(h.id)} title="Remove host">
                  &#x2715;
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Pending tab ───────────────────────────────────────────────────────────────

export function PendingTab({ onCountChange, onChange }: {
  onCountChange: (n: number) => void;
  onChange?: () => void;
}) {
  const [pending, setPending] = useState<PendingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvingFp, setApprovingFp] = useState<string | null>(null);
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await apiFetch('/api/agent/pending');
    if (res.ok) {
      const data = await res.json();
      const list: PendingEntry[] = data.pending ?? [];
      setPending(list);
      onCountChange(list.length);
    }
    setLoading(false);
  }, [onCountChange]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const approve = async (fp: PendingEntry) => {
    setApprovingFp(fp.fingerprint_hex);
    try {
      const dn = displayNames[fp.fingerprint_hex] ?? '';
      await apiFetch(`/api/agent/pending/${fp.fingerprint_hex}/approve`, {
        method: 'POST',
        body: JSON.stringify({ display_name: dn || null }),
      });
      await load();
      onChange?.();
    } finally {
      setApprovingFp(null);
    }
  };

  if (loading) return <div style={S.empty}>Loading...</div>;

  if (pending.length === 0) return (
    <div style={S.empty}>
      <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>&#128274;</div>
      <div style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>
        No agents waiting for approval.
      </div>
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
        <button style={S.iconBtn} onClick={load} title="Refresh">&#x21BB;</button>
      </div>
      <div style={S.list}>
        {pending.map(p => (
          <div key={p.fingerprint_hex} style={S.row}>
            <div style={{ ...S.dot, background: 'var(--c-amber, #f59e0b)' }} title="Pending" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span style={S.hostLabel}>{p.hostname}</span>
                <span style={{ ...S.metaChip, fontFamily: 'monospace', fontSize: '0.7rem' }}>
                  {p.fingerprint.replace('SHA256:', 'SHA256:').substring(0, 20)}…
                </span>
              </div>
              <div style={S.meta}>
                <span style={{ fontFamily: 'monospace' }}>{p.remote_ip}</span>
                <span style={S.metaDot}>·</span>
                <span>waiting {fmtSecs(p.waiting_secs)}</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  style={{ ...S.editInput, flex: '0 1 180px' }}
                  placeholder="Display name (optional)"
                  value={displayNames[p.fingerprint_hex] ?? ''}
                  onChange={e => setDisplayNames(prev => ({ ...prev, [p.fingerprint_hex]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') approve(p); }}
                />
                <button
                  style={{ ...S.saveBtn, background: 'var(--c-green)' }}
                  disabled={approvingFp === p.fingerprint_hex}
                  onClick={() => approve(p)}
                >
                  {approvingFp === p.fingerprint_hex ? '…' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={S.hint}>
        Approve a host to permanently enroll it. Its Ed25519 key will be stored and used
        for authentication on all future connections.
      </div>
    </>
  );
}

// ── Tokens tab ────────────────────────────────────────────────────────────────

const TTL_OPTIONS = [
  { label: '15 minutes', value: 900 },
  { label: '1 hour', value: 3600 },
  { label: '4 hours', value: 14400 },
  { label: '24 hours', value: 86400 },
];

export function TokensTab() {
  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ id: string; token: string; install_cmd: string } | null>(null);
  const [form, setForm] = useState({ ttl: 3600, single_use: true, bound_hostname: '', re_enroll: false });
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/agent/tokens');
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await apiFetch('/api/agent/tokens', {
        method: 'POST',
        body: JSON.stringify({
          ttl_secs: form.ttl,
          single_use: form.single_use,
          bound_hostname: form.bound_hostname.trim() || null,
          re_enroll: form.re_enroll,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setNewToken(data);
        await load();
      }
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    await apiFetch(`/api/agent/tokens/${id}`, { method: 'DELETE' });
    if (newToken?.id === id) setNewToken(null);
    await load();
  };

  const copyCmd = (cmd: string) => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      {/* Create token form */}
      <div style={{ ...S.row, flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>Generate Bootstrap Token</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            style={S.select}
            value={form.ttl}
            onChange={e => setForm(f => ({ ...f, ttl: +e.target.value }))}
          >
            {TTL_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label style={S.checkLabel}>
            <input type="checkbox" checked={form.single_use}
              onChange={e => setForm(f => ({ ...f, single_use: e.target.checked }))} />
            Single-use
          </label>
          <label style={S.checkLabel}>
            <input type="checkbox" checked={form.re_enroll}
              onChange={e => setForm(f => ({ ...f, re_enroll: e.target.checked }))} />
            Re-enroll (replace key)
          </label>
          <input
            style={{ ...S.editInput, flex: '0 1 160px' }}
            placeholder="Bind hostname (optional)"
            value={form.bound_hostname}
            onChange={e => setForm(f => ({ ...f, bound_hostname: e.target.value }))}
          />
          <button style={S.saveBtn} disabled={creating} onClick={create}>
            {creating ? '…' : 'Generate'}
          </button>
        </div>
      </div>

      {/* Newly created token */}
      {newToken && (
        <div style={{ ...S.row, flexDirection: 'column', gap: '0.4rem', marginBottom: '0.5rem', borderColor: 'var(--c-green)' }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--c-green)' }}>
            ✓ Token created — copy the install command below
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: '0.72rem', wordBreak: 'break-all', color: 'var(--text-2)' }}>
            {newToken.install_cmd}
          </div>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button style={S.saveBtn} onClick={() => copyCmd(newToken.install_cmd)}>
              {copied ? '✓ Copied' : 'Copy install command'}
            </button>
            <button style={S.cancelBtn} onClick={() => setNewToken(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={S.empty}>Loading...</div>
      ) : tokens.length === 0 ? (
        <div style={S.empty}>
          <div style={{ color: 'var(--text-2)', fontSize: '0.9rem' }}>
            No active tokens. Generate one above for unattended agent installs.
          </div>
        </div>
      ) : (
        <div style={S.list}>
          {tokens.map(t => (
            <div key={t.id} style={{ ...S.row, opacity: t.expired || t.exhausted ? 0.5 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-2)' }}>
                    {t.id.substring(0, 8)}…
                  </span>
                  {t.re_enroll && <span style={{ ...S.badge, background: 'var(--c-amber, #f59e0b)' }}>re-enroll</span>}
                  {t.bound_hostname && <span style={{ ...S.badge }}>{t.bound_hostname}</span>}
                  {t.expired && <span style={{ ...S.badge, background: 'var(--c-red)' }}>expired</span>}
                  {!t.expired && t.exhausted && <span style={{ ...S.badge, background: 'var(--c-red)' }}>used</span>}
                </div>
                <div style={S.meta}>
                  {t.single_use
                    ? <span>single-use · used {t.use_count}x</span>
                    : <span>multi-use · used {t.use_count}{t.max_uses ? `/${t.max_uses}` : ''}x</span>
                  }
                  {!t.expired && !t.exhausted && (
                    <>
                      <span style={S.metaDot}>·</span>
                      <span>expires in {fmtSecs(t.expires_in_secs)}</span>
                    </>
                  )}
                </div>
              </div>
              <button style={S.removeBtn} onClick={() => revoke(t.id)} title="Revoke">&#x2715;</button>
            </div>
          ))}
        </div>
      )}

      <div style={S.hint}>
        Bootstrap tokens let agents self-enroll without manual approval. Pass <code>--token &lt;value&gt;</code> to
        the agent installer, or set <code>TENODERA_BOOTSTRAP_TOKEN</code> in agent.cnf.
      </div>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.4rem' },
  title:     { fontSize: '1.1rem', fontWeight: 700, margin: 0 },
  tabBtn:    { padding: '0.3rem 0.7rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.8rem' },
  tabActive: { background: 'var(--c-blue)', color: 'var(--bg-app)', borderColor: 'var(--c-blue)', fontWeight: 600 },
  iconBtn:   { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.9rem' },
  empty:     { textAlign: 'center', padding: '2rem', background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' },
  list:      { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  row:       { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6 },
  dot:       { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  hostLabel: { fontWeight: 700, fontSize: '0.9rem' },
  editBtn:   { background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.2rem', opacity: 0.55, lineHeight: 1 },
  editInput: { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-1)', fontSize: '0.9rem', padding: '0.2rem 0.4rem', outline: 'none', flex: 1, minWidth: 0 },
  saveBtn:   { background: 'var(--c-blue)', border: 'none', borderRadius: 4, color: 'var(--bg-app)', fontSize: '0.8rem', padding: '0.2rem 0.6rem', cursor: 'pointer', flexShrink: 0 },
  cancelBtn: { background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.2rem' },
  meta:      { fontSize: '0.75rem', color: 'var(--text-2)', marginTop: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' },
  metaChip:  { opacity: 0.7 },
  metaDot:   { opacity: 0.4 },
  removeBtn: { background: 'transparent', border: 'none', color: 'var(--c-red)', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', padding: '0 0.3rem', flexShrink: 0 },
  hint:      { fontSize: '0.8rem', color: 'var(--text-2)', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.6rem 0.75rem', marginTop: '0.75rem', lineHeight: 1.6 },
  select:    { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-1)', fontSize: '0.85rem', padding: '0.2rem 0.4rem', outline: 'none' },
  checkLabel: { display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: 'var(--text-1)', cursor: 'pointer' },
  badge:     { fontSize: '0.7rem', padding: '0.1rem 0.35rem', borderRadius: 3, background: 'var(--bg-panel)', color: 'var(--text-2)', border: '1px solid var(--border)' },
};
