import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

/* ── types ─────────────────────────────────────────────── */

interface Source {
  code: string; mode: string; state: string; synced: boolean;
  name: string; stratum: string; poll: string; reach: string;
  last_rx: string; last_sample: string;
}
interface Srv { type: string; host: string; options: string }
interface ChronyData {
  available: boolean;
  config_path: string | null;
  tracking: Record<string, string>;
  activity: { online: number; offline: number; unknown: number };
  sources: Source[];
  config_raw: string;
  servers: Srv[];
}

const TRACKING_FIELDS = [
  'Reference ID', 'Stratum', 'Ref time (UTC)', 'System time', 'Last offset',
  'RMS offset', 'Frequency', 'Skew', 'Root delay', 'Root dispersion',
  'Update interval', 'Leap status',
];

const STATE_MAP: Record<string, { label: string; color: string }> = {
  '*': { label: 'synced', color: 'var(--c-green)' },
  '+': { label: 'combined', color: 'var(--c-blue)' },
  '-': { label: 'not combined', color: 'var(--text-2)' },
  '?': { label: 'unreachable', color: 'var(--c-red)' },
  'x': { label: 'falseticker', color: 'var(--c-red)' },
  '~': { label: 'variable', color: 'var(--c-yellow)' },
};
const MODE_MAP: Record<string, string> = { '^': 'server', '=': 'peer', '#': 'local' };

/* ── component ─────────────────────────────────────────── */

export function SystemChrony() {
  const { request } = useTransport();
  const su = useSuperuser();
  const toast = useToast();

  const [d, setD] = useState<ChronyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [servers, setServers] = useState<Srv[]>([]);
  const [raw, setRaw] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const gated = !su.active;

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    request('chrony.manage')
      .then((results) => {
        const data = results[0] as ChronyData | undefined;
        if (data) {
          setD(data);
          setServers(data.servers ?? []);
          setRaw(data.config_raw ?? '');
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const runAction = useCallback(
    async (params: Record<string, unknown>, okMsg: string) => {
      setBusy(true);
      try {
        const [res] = await request('chrony.manage', { ...params, password: su.password });
        const data = res as { error?: string } | undefined;
        if (data?.error) throw new Error(data.error);
        toast.success(okMsg);
        load();
      } catch (e) {
        toast.error(`Failed: ${e}`);
      } finally {
        setBusy(false);
      }
    },
    [request, su.password, toast, load],
  );

  if (loading && !d) return <p style={{ color: 'var(--text-2)' }}>Loading chrony…</p>;
  if (error) return <p style={{ color: 'var(--c-red)' }}>Error: {error}</p>;
  if (d && !d.available) return <p style={{ color: 'var(--text-2)' }}>chrony is not available on this host.</p>;

  const setSrv = (i: number, patch: Partial<Srv>) =>
    setServers((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addSrv = () => setServers((prev) => [...prev, { type: 'server', host: '', options: 'iburst' }]);
  const removeSrv = (i: number) => setServers((prev) => prev.filter((_, idx) => idx !== i));

  const serversDirty = JSON.stringify(servers) !== JSON.stringify(d?.servers ?? []);
  const rawDirty = raw !== (d?.config_raw ?? '');

  return (
    <div>
      {gated && (
        <p style={S.notice}>
          Enable <b>superuser</b> mode (top bar) to edit chrony or run commands.
        </p>
      )}

      <div style={S.toolbar}>
        <button style={S.btn} onClick={load} disabled={loading}>Refresh</button>
        <span style={{ flex: 1 }} />
        <button style={cmdStyle(gated || busy)} disabled={gated || busy}
          onClick={() => runAction({ action: 'command', cmd: 'makestep' }, 'Step requested.')}>Make step</button>
        <button style={cmdStyle(gated || busy)} disabled={gated || busy}
          onClick={() => runAction({ action: 'command', cmd: 'online' }, 'Sources online.')}>Online</button>
        <button style={cmdStyle(gated || busy)} disabled={gated || busy}
          onClick={() => runAction({ action: 'command', cmd: 'offline' }, 'Sources offline.')}>Offline</button>
        <button style={cmdStyle(gated || busy)} disabled={gated || busy}
          onClick={() => runAction({ action: 'command', cmd: 'restart' }, 'chronyd restarted.')}>Restart</button>
      </div>

      {/* Tracking */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Tracking</h3>
        <div style={S.trackGrid}>
          {TRACKING_FIELDS.filter((k) => d?.tracking[k]).map((k) => (
            <div key={k} style={S.trackRow}>
              <span style={S.trackLabel}>{k}</span>
              <span style={S.trackValue}>{d!.tracking[k]}</span>
            </div>
          ))}
        </div>
        <div style={S.activity}>
          <Badge color="var(--c-green)">{d?.activity.online ?? 0} online</Badge>
          <Badge color="var(--text-3)">{d?.activity.offline ?? 0} offline</Badge>
          {(d?.activity.unknown ?? 0) > 0 && <Badge color="var(--c-yellow)">{d!.activity.unknown} unknown</Badge>}
        </div>
      </div>

      {/* Sources */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Sources ({d?.sources.length ?? 0})</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>State</th><th style={S.th}>Mode</th><th style={S.th}>Name / IP</th>
                <th style={S.thN}>Stratum</th><th style={S.thN}>Poll</th><th style={S.thN}>Reach</th>
                <th style={S.thN}>LastRx</th><th style={S.th}>Last sample</th>
              </tr>
            </thead>
            <tbody>
              {d?.sources.map((s, i) => {
                const st = STATE_MAP[s.state] ?? { label: s.state, color: 'var(--text-2)' };
                return (
                  <tr key={i}>
                    <td style={S.td}><span style={{ color: st.color, fontWeight: 600 }}>● {st.label}</span></td>
                    <td style={S.td}>{MODE_MAP[s.mode] ?? s.mode}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{s.name}</td>
                    <td style={S.tdN}>{s.stratum}</td>
                    <td style={S.tdN}>{s.poll}</td>
                    <td style={S.tdN}>{s.reach}</td>
                    <td style={S.tdN}>{s.last_rx}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>{s.last_sample}</td>
                  </tr>
                );
              })}
              {d?.sources.length === 0 && (
                <tr><td style={S.td} colSpan={8}>No sources.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Servers / pools editor */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Servers &amp; pools</h3>
        {servers.map((s, i) => (
          <div key={i} style={S.srvRow}>
            <select style={S.select} value={s.type} disabled={gated}
              onChange={(e) => setSrv(i, { type: e.target.value })}>
              <option value="server">server</option>
              <option value="pool">pool</option>
            </select>
            <input style={{ ...S.input, flex: 2 }} value={s.host} disabled={gated}
              placeholder="host or IP" onChange={(e) => setSrv(i, { host: e.target.value })} />
            <input style={{ ...S.input, flex: 1 }} value={s.options} disabled={gated}
              placeholder="options e.g. iburst" onChange={(e) => setSrv(i, { options: e.target.value })} />
            <button style={S.rmBtn} disabled={gated} onClick={() => removeSrv(i)} title="Remove">×</button>
          </div>
        ))}
        <div style={S.rowActions}>
          <button style={gated ? { ...S.btnGhost, ...S.disabled } : S.btnGhost} disabled={gated} onClick={addSrv}>+ Add</button>
          <button style={saveStyle(gated || busy || !serversDirty)} disabled={gated || busy || !serversDirty}
            onClick={() => runAction({ action: 'set_servers', servers }, 'Servers updated.')}>Save servers</button>
        </div>
      </div>

      {/* Raw config editor */}
      <div style={S.card}>
        <div style={S.rawHeader} onClick={() => setShowRaw((v) => !v)}>
          <h3 style={{ ...S.cardTitle, margin: 0 }}>Raw config {d?.config_path ? `(${d.config_path})` : ''}</h3>
          <span style={S.chev}>{showRaw ? '▼' : '▶'}</span>
        </div>
        {showRaw && (
          <>
            <textarea
              style={S.textarea}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              disabled={gated}
              spellCheck={false}
              rows={16}
            />
            <div style={S.rowActions}>
              <button style={gated || busy || !rawDirty ? { ...S.btnGhost, ...S.disabled } : S.btnGhost}
                disabled={gated || busy || !rawDirty} onClick={() => setRaw(d?.config_raw ?? '')}>Reset</button>
              <button style={saveStyle(gated || busy || !rawDirty)} disabled={gated || busy || !rawDirty}
                onClick={() => runAction({ action: 'save_config', content: raw }, 'chrony.conf saved.')}>Save &amp; restart</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── helpers ───────────────────────────────────────────── */

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: '0.72rem', padding: '0.12rem 0.45rem', borderRadius: 4,
      background: `color-mix(in srgb, ${color} 14%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`, color,
    }}>{children}</span>
  );
}

function saveStyle(disabled: boolean): React.CSSProperties {
  return disabled ? { ...S.saveOn, ...S.disabled } : S.saveOn;
}
function cmdStyle(disabled: boolean): React.CSSProperties {
  return disabled ? { ...S.btnGhost, ...S.disabled } : S.btnGhost;
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  notice: { color: 'var(--text-2)', fontSize: '0.85rem', margin: '0 0 1rem 0' },
  toolbar: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap' },
  btn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.83rem' },
  card: { background: 'var(--bg-panel)', borderRadius: 8, padding: '1rem', marginBottom: '1rem' },
  cardTitle: { margin: '0 0 0.75rem 0', fontSize: '1.05rem' },
  trackGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.35rem' },
  trackRow: { display: 'flex', justifyContent: 'space-between', gap: '0.75rem', padding: '0.3rem 0.5rem', borderRadius: 4, background: 'var(--bg-app)' },
  trackLabel: { color: 'var(--text-2)', fontSize: '0.82rem', whiteSpace: 'nowrap' },
  trackValue: { fontSize: '0.82rem', fontWeight: 600, fontFamily: 'monospace', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis' },
  activity: { display: 'flex', gap: '0.4rem', marginTop: '0.75rem', flexWrap: 'wrap' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', minWidth: 640 },
  th: { textAlign: 'left', padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap' },
  thN: { textAlign: 'right', padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap' },
  td: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' },
  tdN: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap' },
  srvRow: { display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' },
  select: { padding: '0.4rem 0.5rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem' },
  input: { minWidth: 120, padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none' },
  rmBtn: { width: 30, height: 30, borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--c-red)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 },
  rowActions: { display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' },
  btnGhost: { padding: '0.4rem 0.9rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.83rem' },
  saveOn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.83rem' },
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
  rawHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' },
  chev: { color: 'var(--text-2)', fontSize: '0.8rem' },
  textarea: { width: '100%', boxSizing: 'border-box', marginTop: '0.75rem', padding: '0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text-1)', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' },
};
