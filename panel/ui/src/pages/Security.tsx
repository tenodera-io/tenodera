import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { Tabs } from '../components/Tabs.tsx';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

type Req = ReturnType<typeof useTransport>['request'];
type Toast = ReturnType<typeof useToast>;

interface Jail {
  name: string;
  banned_ips: string[];
  currently_banned: number;
  total_banned: number;
  currently_failed: number;
  total_failed: number;
}
interface Fail2ban { available: boolean; active?: boolean; jails?: Jail[] }
interface Selinux { available: boolean; current?: string; config?: string; policy?: string }
interface AaProfile { name: string; mode: string }
interface AppArmor { available: boolean; can_manage?: boolean; enforce?: number; complain?: number; other?: number; profiles?: AaProfile[] }
interface Status { fail2ban: Fail2ban; selinux: Selinux; apparmor: AppArmor }

const TAB_LABEL: Record<string, string> = { fail2ban: 'fail2ban', selinux: 'SELinux', apparmor: 'AppArmor' };

export function Security() {
  const { request } = useTransport();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>('');

  const load = useCallback(() => {
    setLoading(true);
    request('security.status').then((r) => {
      const d = r[0] as Status;
      setStatus(d);
      const avail = availableTabs(d);
      setTab((prev) => (prev && avail.includes(prev) ? prev : (avail[0] ?? '')));
    }).catch(() => { /* best-effort */ }).finally(() => setLoading(false));
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const avail = status ? availableTabs(status) : [];

  return (
    <div>
      <PageHeader
        icon="shield"
        title="Security"
        actions={<button style={S.btn} onClick={load} disabled={loading}>Refresh</button>}
      />

      {loading && !status ? (
        <p style={S.muted}>Loading…</p>
      ) : avail.length === 0 ? (
        <div style={S.card}><span style={S.muted}>No supported hardening subsystem detected (fail2ban, SELinux or AppArmor).</span></div>
      ) : (
        <>
          <Tabs
            tabs={avail.map((id) => ({ id, label: TAB_LABEL[id] }))}
            active={tab}
            onChange={setTab}
            style={{ marginBottom: '1rem' }}
          />
          {tab === 'fail2ban' && status && <Fail2banView data={status.fail2ban} request={request} toast={toast} reload={load} />}
          {tab === 'selinux' && status && <SelinuxView data={status.selinux} request={request} toast={toast} reload={load} />}
          {tab === 'apparmor' && status && <AppArmorView data={status.apparmor} request={request} toast={toast} reload={load} />}
        </>
      )}
    </div>
  );
}

function availableTabs(s: Status): string[] {
  return (['fail2ban', 'selinux', 'apparmor'] as const).filter((k) => s[k]?.available);
}

async function act(request: Req, toast: Toast, params: Record<string, unknown>, reload: () => void, ok: string) {
  try {
    const [res] = await request('security.manage', params);
    const d = res as { error?: string };
    if (d?.error) throw new Error(d.error);
    toast.success(ok);
    reload();
  } catch (e) { toast.error(String(e)); }
}

/* ── fail2ban ──────────────────────────────────────────── */

function Fail2banView({ data, request, toast, reload }: { data: Fail2ban; request: Req; toast: Toast; reload: () => void }) {
  const [banIp, setBanIp] = useState('');
  const [banJail, setBanJail] = useState('');

  if (!data.active) {
    return <div style={S.card}><span style={S.muted}>fail2ban is installed but the daemon is not running.</span></div>;
  }
  const jails = data.jails ?? [];
  return (
    <div>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={S.btn} onClick={() => act(request, toast, { action: 'fail2ban_reload' }, reload, 'fail2ban reloaded.')}>Reload</button>
        <span style={S.muted}>{jails.length} jail{jails.length === 1 ? '' : 's'}</span>
      </div>

      {jails.map((j) => (
        <div key={j.name} style={S.card}>
          <div style={S.rowHead}>
            <h3 style={S.cardTitle}>{j.name}</h3>
            <span style={S.muted}>banned {j.currently_banned} (total {j.total_banned}) · failed {j.currently_failed} (total {j.total_failed})</span>
          </div>
          {j.banned_ips.length === 0 ? (
            <span style={S.muted}>No banned IPs.</span>
          ) : (
            <table style={S.table}>
              <tbody>
                {j.banned_ips.map((ip) => (
                  <tr key={ip}>
                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{ip}</td>
                    <td style={{ ...S.td, textAlign: 'right', width: 90 }}>
                      <button style={S.smallBtn} onClick={() => act(request, toast, { action: 'fail2ban_unban', jail: j.name, ip }, reload, `Unbanned ${ip}.`)}>Unban</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <div style={S.card}>
        <h3 style={S.cardTitle}>Ban an IP</h3>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={S.select} value={banJail} onChange={(e) => setBanJail(e.target.value)}>
            <option value="">jail…</option>
            {jails.map((j) => <option key={j.name} value={j.name}>{j.name}</option>)}
          </select>
          <input style={S.input} value={banIp} onChange={(e) => setBanIp(e.target.value)} placeholder="1.2.3.4" spellCheck={false} />
          <button
            style={{ ...S.btnDanger, opacity: banJail && banIp.trim() ? 1 : 0.5 }}
            disabled={!banJail || !banIp.trim()}
            onClick={() => act(request, toast, { action: 'fail2ban_ban', jail: banJail, ip: banIp.trim() }, reload, `Banned ${banIp.trim()}.`).then(() => setBanIp(''))}
          >Ban</button>
        </div>
      </div>
    </div>
  );
}

/* ── SELinux ───────────────────────────────────────────── */

interface SeBool { name: string; on: boolean }
interface Denial { time: string; comm: string; op: string; scontext: string; tcontext: string; tclass: string; permissive: string }

function SelinuxView({ data, request, toast, reload }: { data: Selinux; request: Req; toast: Toast; reload: () => void }) {
  const [persist, setPersist] = useState(false);
  const [sub, setSub] = useState<'booleans' | 'denials' | 'modules' | 'relabel'>('booleans');
  const current = data.current ?? 'unknown';
  const disabled = current === 'disabled';

  const setMode = (mode: string) => act(request, toast, { action: 'selinux_setenforce', mode, persist: String(persist) }, reload, `SELinux → ${mode}${persist ? ' (persisted)' : ''}.`);

  return (
    <div>
      <div style={S.card}>
        <div style={S.rowHead}>
          <h3 style={S.cardTitle}>SELinux</h3>
          <Badge value={current} />
        </div>
        <div style={S.kv}><span style={S.kvLabel}>Config default:</span> <span style={S.mono}>{data.config || '—'}</span></div>
        <div style={S.kv}><span style={S.kvLabel}>Policy:</span> <span style={S.mono}>{data.policy || '—'}</span></div>

        {disabled ? (
          <p style={S.muted}>SELinux is disabled. Enabling it requires editing the config and a reboot — not done from here.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.9rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={current === 'enforcing' ? S.segActive : S.seg} onClick={() => setMode('enforcing')}>Enforcing</button>
              <button style={current === 'permissive' ? S.segActive : S.seg} onClick={() => setMode('permissive')}>Permissive</button>
              <label style={S.check}>
                <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} /> persist to config
              </label>
            </div>
            <p style={S.muted}>Runtime change is immediate; “persist” also rewrites <code>/etc/selinux/config</code>. Switching to Disabled needs a reboot and isn’t offered here.</p>
          </>
        )}
      </div>

      <Tabs
        tabs={[{ id: 'booleans', label: 'Booleans' }, { id: 'denials', label: 'Denials' }, { id: 'modules', label: 'Modules' }, { id: 'relabel', label: 'Relabel' }]}
        active={sub}
        onChange={(t) => setSub(t as typeof sub)}
        style={{ marginBottom: '1rem' }}
      />
      {sub === 'booleans' && <SelBooleans request={request} toast={toast} />}
      {sub === 'denials' && <SelDenials request={request} />}
      {sub === 'modules' && <SelModules request={request} />}
      {sub === 'relabel' && <SelRelabel request={request} toast={toast} />}
    </div>
  );
}

function SelBooleans({ request, toast }: { request: Req; toast: Toast }) {
  const [bools, setBools] = useState<SeBool[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [persist, setPersist] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    request('security.status', { query: 'selinux_booleans' }).then((r) => {
      setBools((r[0] as { booleans?: SeBool[] })?.booleans ?? []);
    }).catch(() => { /* best-effort */ }).finally(() => setLoading(false));
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (b: SeBool) => {
    setBusy(b.name);
    try {
      const [res] = await request('security.manage', { action: 'selinux_setbool', name: b.name, value: b.on ? 'off' : 'on', persist: String(persist) });
      const d = res as { error?: string };
      if (d?.error) throw new Error(d.error);
      setBools((prev) => prev.map((x) => (x.name === b.name ? { ...x, on: !x.on } : x)));
    } catch (e) { toast.error(String(e)); } finally { setBusy(''); }
  };

  const q = filter.trim().toLowerCase();
  const rows = q ? bools.filter((b) => b.name.toLowerCase().includes(q)) : bools;

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        <input style={S.input} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter booleans…" spellCheck={false} />
        <label style={S.check}><input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} /> persist (-P)</label>
        <span style={S.muted}>{loading ? 'Loading…' : `${rows.length} / ${bools.length}`}</span>
      </div>
      <div style={{ maxHeight: 460, overflow: 'auto' }}>
        <table style={S.table}>
          <tbody>
            {rows.map((b) => (
              <tr key={b.name}>
                <td style={{ ...S.td, fontFamily: 'monospace', wordBreak: 'break-all' }}>{b.name}</td>
                <td style={{ ...S.td, width: 90, textAlign: 'right' }}>
                  <button
                    disabled={busy === b.name}
                    onClick={() => toggle(b)}
                    style={b.on ? S.toggleOn : S.toggleOff}
                    title={b.on ? 'on — click to turn off' : 'off — click to turn on'}
                  >{b.on ? 'on' : 'off'}</button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td style={S.td} colSpan={2}><span style={S.muted}>No matching booleans.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SelDenials({ request }: { request: Req }) {
  const [denials, setDenials] = useState<Denial[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    request('security.status', { query: 'selinux_denials' }).then((r) => {
      setDenials((r[0] as { denials?: Denial[] })?.denials ?? []);
    }).catch(() => { /* best-effort */ }).finally(() => setLoading(false));
  }, [request]);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={S.card}>
      <div style={S.rowHead}>
        <h3 style={S.cardTitle}>Recent denials <span style={S.muted}>({denials.length})</span></h3>
        <button style={S.btn} onClick={load} disabled={loading}>Refresh</button>
      </div>
      <div style={{ maxHeight: 460, overflow: 'auto' }}>
        <table style={S.table}>
          <thead><tr><th style={S.th}>Time</th><th style={S.th}>Process</th><th style={S.th}>Op</th><th style={S.th}>Source → Target</th><th style={S.th}>Class</th></tr></thead>
          <tbody>
            {denials.map((d, i) => (
              <tr key={i}>
                <td style={{ ...S.td, whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.76rem' }}>{d.time}</td>
                <td style={{ ...S.td, fontFamily: 'monospace' }}>{d.comm || '—'}</td>
                <td style={S.td}>{d.op || '—'}</td>
                <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.76rem', color: 'var(--text-2)' }}>{seType(d.scontext)} → {seType(d.tcontext)}</td>
                <td style={S.td}>{d.tclass}{d.permissive === '1' ? ' ·permissive' : ''}</td>
              </tr>
            ))}
            {!loading && denials.length === 0 && <tr><td style={S.td} colSpan={5}><span style={S.muted}>No denials this boot.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Shorten an SELinux context (user:role:type:level) to just the type.
function seType(ctx: string): string {
  const parts = (ctx || '').split(':');
  return parts.length >= 3 ? parts[2] : (ctx || '—');
}

function SelModules({ request }: { request: Req }) {
  const [mods, setMods] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    request('security.status', { query: 'selinux_modules' }).then((r) => {
      setMods((r[0] as { modules?: string[] })?.modules ?? []);
    }).catch(() => { /* best-effort */ }).finally(() => setLoading(false));
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const q = filter.trim().toLowerCase();
  const rows = q ? mods.filter((m) => m.toLowerCase().includes(q)) : mods;

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
        <input style={S.input} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter modules…" spellCheck={false} />
        <span style={S.muted}>{loading ? 'Loading…' : `${rows.length} / ${mods.length}`}</span>
      </div>
      <div style={{ maxHeight: 460, overflow: 'auto' }}>
        <table style={S.table}>
          <tbody>
            {rows.map((m) => <tr key={m}><td style={{ ...S.td, fontFamily: 'monospace' }}>{m}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SelRelabel({ request, toast }: { request: Req; toast: Toast }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');

  const run = async () => {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setOutput('');
    try {
      const [res] = await request('security.manage', { action: 'selinux_restorecon', path: p });
      const d = res as { error?: string; output?: string };
      if (d?.error) throw new Error(d.error);
      setOutput(d.output || '(no changes — contexts already correct)');
      toast.success('Relabel complete.');
    } catch (e) { toast.error(String(e)); } finally { setBusy(false); }
  };

  return (
    <div style={S.card}>
      <h3 style={S.cardTitle}>Restore file contexts</h3>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.5rem 0' }}>
        <input style={{ ...S.input, minWidth: 260 }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/var/www" spellCheck={false} />
        <button style={{ ...S.btn, opacity: path.trim() && !busy ? 1 : 0.5 }} disabled={!path.trim() || busy} onClick={run}>{busy ? 'Relabeling…' : 'Relabel (restorecon -R)'}</button>
      </div>
      <p style={S.muted}>Recursively resets SELinux file contexts to the policy default under the given path (<code>restorecon -Rv</code>). Capped at 120s; large trees may need a targeted path.</p>
      {output && <pre style={S.log}>{output}</pre>}
    </div>
  );
}

/* ── AppArmor ──────────────────────────────────────────── */

function AppArmorView({ data, request, toast, reload }: { data: AppArmor; request: Req; toast: Toast; reload: () => void }) {
  const profiles = data.profiles ?? [];
  return (
    <div style={S.card}>
      <div style={S.rowHead}>
        <h3 style={S.cardTitle}>AppArmor</h3>
        <span style={S.muted}>enforce {data.enforce ?? 0} · complain {data.complain ?? 0}{data.other ? ` · other ${data.other}` : ''}</span>
      </div>
      {!data.can_manage && (
        <p style={S.muted}>Install <code>apparmor-utils</code> (aa-enforce/aa-complain) to change profile modes from here.</p>
      )}
      <div style={{ maxHeight: 480, overflow: 'auto', marginTop: '0.5rem' }}>
        <table style={S.table}>
          <thead><tr><th style={S.th}>Profile</th><th style={S.th}>Mode</th>{data.can_manage && <th style={{ ...S.th, width: 170 }} />}</tr></thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.name}>
                <td style={{ ...S.td, fontFamily: 'monospace', wordBreak: 'break-all' }}>{p.name}</td>
                <td style={S.td}><Badge value={p.mode} /></td>
                {data.can_manage && (
                  <td style={S.td}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button style={p.mode === 'enforce' ? S.segActiveSm : S.segSm} onClick={() => act(request, toast, { action: 'apparmor_set', profile: p.name, mode: 'enforce' }, reload, `${p.name} → enforce.`)}>Enforce</button>
                      <button style={p.mode === 'complain' ? S.segActiveSm : S.segSm} onClick={() => act(request, toast, { action: 'apparmor_set', profile: p.name, mode: 'complain' }, reload, `${p.name} → complain.`)}>Complain</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {profiles.length === 0 && <tr><td style={S.td} colSpan={3}><span style={S.muted}>No profiles loaded.</span></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Badge({ value }: { value: string }) {
  const c = value === 'enforcing' || value === 'enforce' ? 'var(--c-green)'
    : value === 'permissive' || value === 'complain' ? 'var(--c-orange)'
    : value === 'disabled' ? 'var(--c-red)' : 'var(--text-2)';
  return <span style={{ display: 'inline-block', padding: '0.15rem 0.55rem', borderRadius: 999, fontSize: '0.76rem', fontWeight: 600, background: `color-mix(in srgb, ${c} 15%, transparent)`, color: c }}>{value}</span>;
}

const S: Record<string, React.CSSProperties> = {
  card: { background: 'var(--bg-panel)', borderRadius: 8, padding: '1rem', marginBottom: '1rem' },
  cardTitle: { margin: 0, fontSize: '1.02rem' },
  rowHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' },
  muted: { color: 'var(--text-2)', fontSize: '0.83rem' },
  mono: { fontFamily: 'monospace', fontSize: '0.83rem', color: 'var(--text-1)' },
  kv: { fontSize: '0.85rem', marginBottom: '0.3rem' },
  kvLabel: { color: 'var(--text-2)', marginRight: '0.4rem' },
  btn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.83rem' },
  btnDanger: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-red)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.83rem', fontWeight: 600 },
  smallBtn: { padding: '0.25rem 0.7rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--c-orange)', cursor: 'pointer', fontSize: '0.8rem' },
  select: { padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem' },
  input: { padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', fontFamily: 'monospace', outline: 'none', minWidth: 160 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' },
  th: { textAlign: 'left', padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontWeight: 500, position: 'sticky', top: 0, background: 'var(--bg-panel)' },
  td: { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' },
  seg: { padding: '0.4rem 1rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.85rem' },
  segActive: { padding: '0.4rem 1rem', borderRadius: 6, border: '1px solid var(--c-blue)', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 },
  segSm: { padding: '0.25rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.78rem' },
  segActiveSm: { padding: '0.25rem 0.6rem', borderRadius: 5, border: '1px solid var(--c-blue)', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 },
  check: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem', color: 'var(--text-2)' },
  toggleOn: { padding: '0.2rem 0.7rem', borderRadius: 999, border: '1px solid var(--c-green)', background: 'color-mix(in srgb, var(--c-green) 18%, transparent)', color: 'var(--c-green)', cursor: 'pointer', fontSize: '0.76rem', fontWeight: 600, minWidth: 44 },
  toggleOff: { padding: '0.2rem 0.7rem', borderRadius: 999, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.76rem', minWidth: 44 },
  log: { margin: '0.5rem 0 0', padding: '0.6rem 0.75rem', maxHeight: 280, overflow: 'auto', background: 'var(--bg-app)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'monospace', fontSize: '0.76rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)' },
};
