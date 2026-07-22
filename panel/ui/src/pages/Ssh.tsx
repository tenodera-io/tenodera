import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { Icon } from '../components/Icons.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTabParam } from '../hooks/useTabParam.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

type Req = ReturnType<typeof useTransport>['request'];
type Toast = ReturnType<typeof useToast>;

interface SshKey { type: string; comment: string; preview: string; raw: string }
interface SshUser { name: string; uid: number; home: string }

export function Ssh({ loginUser }: { loginUser: string }) {
  const { request: baseRequest } = useTransport();
  const su = useSuperuser();
  // Key/sshd mutations now run on the host under the operator's own sudo, so
  // attach their superuser password. This page is superuser-gated; the read
  // actions ignore the extra field.
  const request = useCallback(
    (payload: string, options: Record<string, unknown> = {}): Promise<unknown[]> =>
      baseRequest(
        payload,
        payload === 'ssh.manage' ? { ...options, password: su.password } : options,
      ),
    [baseRequest, su.password],
  );
  const toast = useToast();
  const [tab, setTab] = useTabParam<'keys' | 'sshd'>(['keys', 'sshd'], 'keys');
  return (
    <div>
      <PageHeader icon="key" title="SSH access" />
      <Tabs
        tabs={[{ id: 'keys', label: 'Authorized keys' }, { id: 'sshd', label: 'Server config' }]}
        active={tab}
        onChange={(t) => setTab(t as 'keys' | 'sshd')}
        style={{ marginBottom: '1rem' }}
      />
      {tab === 'keys' ? <KeysTab request={request} toast={toast} loginUser={loginUser} /> : <SshdTab request={request} toast={toast} />}
    </div>
  );
}

/* ── Authorized keys ───────────────────────────────────── */

function KeysTab({ request, toast, loginUser }: { request: Req; toast: Toast; loginUser: string }) {
  const [users, setUsers] = useState<SshUser[]>([]);
  const [userInput, setUserInput] = useState(loginUser);
  const [user, setUser] = useState(loginUser);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [path, setPath] = useState('');
  const [newKey, setNewKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState('');

  // Local users are offered as autocomplete suggestions; the field stays free
  // text so non-enumerated directory users (FreeIPA/AD) can be typed in too.
  useEffect(() => {
    request('ssh.manage', { action: 'list_users' }).then((r) => {
      setUsers((r[0] as { users?: SshUser[] })?.users ?? []);
    }).catch(() => { /* best-effort */ });
  }, [request]);

  const loadKeys = useCallback(() => {
    if (!user) return;
    setLoading(true);
    setEditIdx(null);
    request('ssh.manage', { action: 'list_keys', user }).then((r) => {
      const d = r[0] as { keys?: SshKey[]; path?: string; error?: string };
      if (d?.error) toast.error(`${user}: ${d.error}`);
      setKeys(d?.keys ?? []);
      setPath(d?.path ?? '');
    }).catch(() => { /* best-effort */ }).finally(() => setLoading(false));
  }, [request, user, toast]);
  useEffect(() => { loadKeys(); }, [loadKeys]);

  // Commit the typed username (Enter / blur / suggestion pick) → triggers reload.
  const commitUser = (name: string) => { const n = name.trim(); if (n && n !== user) setUser(n); };

  const addKey = async () => {
    const k = newKey.trim();
    if (!k) return;
    setBusy(true);
    try {
      const [res] = await request('ssh.manage', { action: 'add_key', user, key: k });
      const d = res as { error?: string };
      if (d?.error) throw new Error(d.error);
      toast.success('Key added.');
      setNewKey('');
      loadKeys();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  };

  const removeKey = async (raw: string) => {
    setBusy(true);
    try {
      const [res] = await request('ssh.manage', { action: 'remove_key', user, key: raw });
      const d = res as { error?: string };
      if (d?.error) throw new Error(d.error);
      toast.success('Key removed.');
      loadKeys();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  };

  const saveEdit = async (oldRaw: string) => {
    const nk = editVal.trim();
    if (!nk) return;
    if (nk === oldRaw.trim()) { setEditIdx(null); return; }
    setBusy(true);
    try {
      const [res] = await request('ssh.manage', { action: 'edit_key', user, old: oldRaw, key: nk });
      const d = res as { error?: string };
      if (d?.error) throw new Error(d.error);
      toast.success('Key updated.');
      setEditIdx(null);
      loadKeys();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      <div style={S.userBar}>
        <div style={S.field}>
          <label style={S.fieldLabel}>User</label>
          <input
            list="ssh-users"
            style={S.userInput}
            value={userInput}
            onChange={(e) => { setUserInput(e.target.value); if (users.some((u) => u.name === e.target.value)) commitUser(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitUser(userInput); }}
            onBlur={() => commitUser(userInput)}
            placeholder="username (local or FreeIPA)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <datalist id="ssh-users">
            {users.map((u) => <option key={u.name} value={u.name}>{`uid ${u.uid}`}</option>)}
          </datalist>
        </div>
        <button style={S.btn} onClick={() => { commitUser(userInput); loadKeys(); }} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {path && (
          <span style={S.pathHint}>
            <Icon name="files" size={14} style={{ opacity: 0.7 }} />
            {path}
          </span>
        )}
      </div>

      <div style={S.card}>
        <h3 style={S.cardTitle}>Authorized keys ({keys.length})</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={S.table}>
            <thead><tr><th style={S.th}>Type</th><th style={S.th}>Comment</th><th style={S.th}>Key</th><th style={{ ...S.th, width: 78 }} /></tr></thead>
            <tbody>
              {keys.map((k, i) => (
                editIdx === i ? (
                  <tr key={i}>
                    <td style={S.td} colSpan={3}>
                      <textarea style={S.textarea} rows={3} value={editVal} onChange={(e) => setEditVal(e.target.value)} spellCheck={false} />
                    </td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button style={S.iconOk} disabled={busy} onClick={() => saveEdit(k.raw)} title="Save">✓</button>
                        <button style={S.icon} disabled={busy} onClick={() => setEditIdx(null)} title="Cancel">×</button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td style={S.td}>{k.type}</td>
                    <td style={S.td}>{k.comment || '—'}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-2)' }}>{k.preview}</td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button style={S.icon} disabled={busy} onClick={() => { setEditIdx(i); setEditVal(k.raw); }} title="Edit key">✎</button>
                        <button style={S.rm} disabled={busy} onClick={() => removeKey(k.raw)} title="Remove key">×</button>
                      </div>
                    </td>
                  </tr>
                )
              ))}
              {keys.length === 0 && <tr><td style={S.td} colSpan={4}><span style={S.muted}>No keys.</span></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div style={S.card}>
        <h3 style={S.cardTitle}>Add Public Key</h3>
        <textarea style={S.textarea} rows={3} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="ssh-ed25519 AAAA… user@host" spellCheck={false} />
        <div style={{ marginTop: '0.6rem' }}>
          <button style={{ ...S.btnSuccess, opacity: newKey.trim() && !busy ? 1 : 0.5, cursor: newKey.trim() && !busy ? 'pointer' : 'not-allowed' }}
            disabled={!newKey.trim() || busy} onClick={addKey}>Add key</button>
        </div>
      </div>
    </div>
  );
}

/* ── sshd_config ───────────────────────────────────────── */

interface SshdRow { comment: boolean; raw?: string; key?: string; value?: string }

function parseSshd(content: string): SshdRow[] {
  return content.split('\n').map((line) => {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return { comment: true, raw: line };
    const m = t.match(/^(\S+)\s+(.*)$/);
    return m ? { comment: false, key: m[1], value: m[2] } : { comment: false, key: t, value: '' };
  });
}
function buildSshd(rows: SshdRow[]): string {
  const body = rows
    .map((r) => (r.comment ? (r.raw ?? '') : `${(r.key ?? '').trim()} ${(r.value ?? '').trim()}`.trim()))
    .join('\n')
    .replace(/\n+$/, '');
  return body + '\n';
}

function SshdTab({ request, toast }: { request: Req; toast: Toast }) {
  const [rows, setRows] = useState<SshdRow[]>([]);
  const [orig, setOrig] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    request('ssh.manage', { action: 'read_sshd' }).then((r) => {
      const d = r[0] as { content?: string; path?: string };
      const c = d?.content ?? '';
      setRows(parseSshd(c));
      setOrig(c);
      setPath(d?.path ?? '');
    }).catch(() => { /* best-effort */ }).finally(() => setLoading(false));
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const content = buildSshd(rows);
  const changed = content !== orig;
  const dirs = rows.map((r, i) => ({ r, i })).filter((x) => !x.r.comment);

  const update = (i: number, patch: Partial<SshdRow>) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((p) => p.filter((_, idx) => idx !== i));
  const add = () => setRows((p) => [...p, { comment: false, key: '', value: '' }]);

  const save = async () => {
    setBusy(true);
    try {
      const [res] = await request('ssh.manage', { action: 'set_sshd', content });
      const d = res as { error?: string; reloaded?: string };
      if (d?.error) throw new Error(d.error);
      toast.success(`sshd_config saved & reloaded (${d?.reloaded || 'sshd'}).`);
      load();
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h3 style={{ ...S.cardTitle, marginBottom: 0 }}>{path || '/etc/ssh/sshd_config'} <span style={S.muted}>({dirs.length} directives)</span></h3>
        <button style={S.btn} onClick={load} disabled={loading}>Refresh</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={S.table}>
          <thead><tr><th style={{ ...S.th, width: '38%' }}>Directive</th><th style={S.th}>Value</th><th style={{ ...S.th, width: 44 }} /></tr></thead>
          <tbody>
            {dirs.map(({ r, i }) => (
              <tr key={i}>
                <td style={S.td}><input style={S.inp} value={r.key ?? ''} onChange={(e) => update(i, { key: e.target.value })} placeholder="e.g. PermitRootLogin" /></td>
                <td style={S.td}><input style={S.inp} value={r.value ?? ''} onChange={(e) => update(i, { value: e.target.value })} placeholder="e.g. no" /></td>
                <td style={S.td}><button style={S.rm} onClick={() => remove(i)} title="Remove directive">×</button></td>
              </tr>
            ))}
            {dirs.length === 0 && <tr><td style={S.td} colSpan={3}><span style={S.muted}>No directives.</span></td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button style={S.btnGhost} onClick={add}>+ Add directive</button>
        <span style={{ flex: 1 }} />
        {changed && <button style={S.btnGhost} onClick={() => setRows(parseSshd(orig))}>Revert</button>}
        <button style={{ ...S.btnSuccess, opacity: changed && !busy ? 1 : 0.5, cursor: changed && !busy ? 'pointer' : 'not-allowed' }}
          disabled={!changed || busy} onClick={save}>Save &amp; reload</button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  card: { background: 'var(--bg-panel)', borderRadius: 8, padding: '1rem', marginBottom: '1rem' },
  cardTitle: { margin: '0 0 0.75rem 0', fontSize: '1.05rem' },
  muted: { color: 'var(--text-2)', fontSize: '0.82rem' },
  mono: { color: 'var(--text-2)', fontSize: '0.8rem', fontFamily: 'monospace' },
  lbl: { color: 'var(--text-2)', fontSize: '0.85rem' },
  userBar: { display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', background: 'var(--bg-panel)', borderRadius: 8, padding: '0.85rem 1rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.3rem' },
  fieldLabel: { color: 'var(--text-2)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 },
  userInput: { width: 250, maxWidth: '100%', boxSizing: 'border-box', padding: '0.45rem 0.65rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.9rem', outline: 'none' },
  pathHint: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-2)', fontSize: '0.8rem', fontFamily: 'monospace', paddingBottom: '0.5rem' },
  btn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.83rem' },
  btnSuccess: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-green)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.83rem' },
  btnGhost: { padding: '0.4rem 0.9rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.83rem' },
  select: { padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem', minWidth: 560 },
  th: { textAlign: 'left', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap' },
  td: { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top' },
  inp: { width: '100%', boxSizing: 'border-box', padding: '0.35rem 0.5rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', fontFamily: 'monospace', outline: 'none' },
  textarea: { width: '100%', boxSizing: 'border-box', padding: '0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text-1)', fontFamily: 'monospace', fontSize: '0.82rem', resize: 'vertical' },
  rm: { width: 28, height: 28, borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--c-red)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 },
  icon: { width: 28, height: 28, borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 },
  iconOk: { width: 28, height: 28, borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--c-green)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 },
};
