import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

/* ── types ─────────────────────────────────────────────── */

interface Dev {
  name: string;
  path: string;
  fstype: string;
  size: number;
  type: string;
  uuid: string;
  label: string;
  ro: boolean;
  mountpoint: string | null;
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—';
  const u = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

/* ── component ─────────────────────────────────────────── */

export function StorageMounts() {
  const { request } = useTransport();
  const su = useSuperuser();
  const toast = useToast();

  const [devices, setDevices] = useState<Dev[]>([]);
  const [fstab, setFstab] = useState('');
  const [fstabDraft, setFstabDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [mountFor, setMountFor] = useState<Dev | null>(null);
  const [mTarget, setMTarget] = useState('');
  const [mOptions, setMOptions] = useState('');

  const gated = !su.active;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [b] = await request('storage.manage', { action: 'list_block' });
      setDevices(((b as { devices?: Dev[] })?.devices) ?? []);
      const [f] = await request('storage.manage', { action: 'read_fstab' });
      const content = ((f as { content?: string })?.content) ?? '';
      setFstab(content);
      setFstabDraft(content);
    } catch { /* best-effort */ }
    setLoading(false);
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async (params: Record<string, unknown>, okMsg: string): Promise<boolean> => {
    setBusy(true);
    try {
      const [res] = await request('storage.manage', { ...params, password: su.password });
      const err = (res as { error?: string })?.error;
      if (err) throw new Error(err);
      toast.success(okMsg);
      await load();
      return true;
    } catch (e) {
      toast.error(`Failed: ${e}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [request, su.password, toast, load]);

  const openMount = (d: Dev) => {
    setMountFor(d);
    setMTarget(d.label ? `/mnt/${d.label}` : `/mnt/${d.name}`);
    setMOptions('');
  };

  const doMount = async () => {
    if (!mountFor) return;
    const ok = await run(
      { action: 'mount', source: mountFor.path, target: mTarget.trim(), fstype: mountFor.fstype, options: mOptions.trim() },
      `Mounted ${mountFor.name} at ${mTarget}.`,
    );
    if (ok) setMountFor(null);
  };

  const fstabDirty = fstabDraft !== fstab;

  // Mountable = has a filesystem and isn't the whole-disk container.
  const mountable = devices.filter(d => d.fstype && d.fstype !== 'swap');

  return (
    <div>
      {gated && (
        <p style={S.notice}>Enable <b>superuser</b> mode (top bar) to mount/unmount devices or edit fstab.</p>
      )}

      <div style={S.card}>
        <div style={S.cardHead}>
          <h3 style={S.cardTitle}>Block devices</h3>
          <button style={S.btn} onClick={load} disabled={loading}>Refresh</button>
        </div>
        {loading && devices.length === 0 ? (
          <p style={S.muted}>Loading…</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Device</th><th style={S.th}>Type</th><th style={S.th}>FS</th>
                  <th style={S.thN}>Size</th><th style={S.th}>Label</th><th style={S.th}>Mounted at</th><th style={S.th} />
                </tr>
              </thead>
              <tbody>
                {mountable.map((d) => (
                  <tr key={d.path}>
                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{d.path}</td>
                    <td style={S.td}>{d.type}</td>
                    <td style={S.td}>{d.fstype}</td>
                    <td style={S.tdN}>{fmtSize(d.size)}</td>
                    <td style={S.td}>{d.label || '—'}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{d.mountpoint || '—'}</td>
                    <td style={S.td}>
                      {d.mountpoint ? (
                        <button style={disabledIf(S.btnDanger, gated || busy)} disabled={gated || busy}
                          onClick={() => run({ action: 'unmount', target: d.mountpoint }, `Unmounted ${d.name}.`)}>Unmount</button>
                      ) : (
                        <button style={disabledIf(S.btnPrimary, gated || busy)} disabled={gated || busy}
                          onClick={() => openMount(d)}>Mount</button>
                      )}
                    </td>
                  </tr>
                ))}
                {mountable.length === 0 && <tr><td style={S.td} colSpan={7}>No mountable filesystems found.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <h3 style={S.cardTitle}>/etc/fstab</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button style={disabledIf(S.btnGhost, !fstabDirty)} disabled={!fstabDirty} onClick={() => setFstabDraft(fstab)}>Reset</button>
            <button style={disabledIf(S.btnPrimary, gated || busy || !fstabDirty)} disabled={gated || busy || !fstabDirty}
              onClick={() => run({ action: 'write_fstab', content: fstabDraft }, 'fstab saved.')}>Save</button>
          </div>
        </div>
        <textarea style={S.textarea} value={fstabDraft} onChange={(e) => setFstabDraft(e.target.value)} disabled={gated} spellCheck={false} rows={14} />
        <p style={S.hint}>Saved to /etc/fstab (a backup is kept as /etc/fstab.tenodera.bak). Does not auto-mount — use the table above or reboot.</p>
      </div>

      {mountFor && (
        <div style={S.overlay} onClick={() => setMountFor(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={S.cardTitle}>Mount {mountFor.name}</h3>
            <div style={S.field}>
              <label style={S.label}>Source</label>
              <div style={S.readonly}>{mountFor.path} · {mountFor.fstype}</div>
            </div>
            <div style={S.field}>
              <label style={S.label}>Mount point</label>
              <input style={S.input} value={mTarget} onChange={(e) => setMTarget(e.target.value)} placeholder="/mnt/data" />
            </div>
            <div style={S.field}>
              <label style={S.label}>Options (optional)</label>
              <input style={S.input} value={mOptions} onChange={(e) => setMOptions(e.target.value)} placeholder="e.g. rw,noatime" />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button style={S.btnGhost} onClick={() => setMountFor(null)}>Cancel</button>
              <button style={disabledIf(S.btnPrimary, busy || !mTarget.trim())} disabled={busy || !mTarget.trim()} onClick={doMount}>Mount</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function disabledIf(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled ? { ...base, opacity: 0.5, cursor: 'not-allowed' } : base;
}

const S: Record<string, React.CSSProperties> = {
  notice: { color: 'var(--text-2)', fontSize: '0.85rem', margin: '0 0 1rem 0' },
  card: { background: 'var(--bg-panel)', borderRadius: 8, padding: '1rem', marginBottom: '1rem' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.75rem', flexWrap: 'wrap' },
  cardTitle: { margin: 0, fontSize: '1.05rem' },
  muted: { color: 'var(--text-2)', fontSize: '0.85rem' },
  hint: { fontSize: '0.72rem', color: 'var(--text-2)', marginTop: '0.5rem' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem', minWidth: 640 },
  th: { textAlign: 'left', padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap' },
  thN: { textAlign: 'right', padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap' },
  td: { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' },
  tdN: { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap' },
  btn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.83rem' },
  btnPrimary: { padding: '0.35rem 0.8rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' },
  btnDanger: { padding: '0.35rem 0.8rem', borderRadius: 5, border: 'none', background: 'var(--c-red)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' },
  btnGhost: { padding: '0.35rem 0.8rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.8rem' },
  textarea: { width: '100%', boxSizing: 'border-box', padding: '0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text-1)', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500 },
  modal: { background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 10, padding: '1.25rem', width: '100%', maxWidth: 440 },
  field: { marginBottom: '0.75rem' },
  label: { display: 'block', fontSize: '0.78rem', color: 'var(--text-2)', marginBottom: '0.3rem' },
  input: { width: '100%', boxSizing: 'border-box', padding: '0.45rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none' },
  readonly: { padding: '0.45rem 0.6rem', borderRadius: 5, background: 'var(--bg-panel)', fontFamily: 'monospace', fontSize: '0.82rem' },
};
