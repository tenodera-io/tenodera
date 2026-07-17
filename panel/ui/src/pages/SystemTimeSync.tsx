import { useEffect, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

/* ── types ─────────────────────────────────────────────── */

interface TimeSyncData {
  available: boolean;
  daemon: string;
  label: string;
  unit: string;
  active: boolean;
  enabled: boolean;
  status_label: string;
  status_text: string;
  config_path: string | null;
  config_raw: string;
  config_editable: boolean;
}

/* ── component ─────────────────────────────────────────── */

// Generic management for non-chrony time-sync daemons (systemd-timesyncd,
// ntpd/ntpsec, OpenNTPD, ptp4l/phc2sys): status readout + config editor +
// service controls. Chrony has its own richer SystemChrony component.
export function SystemTimeSync({ daemon }: { daemon: string }) {
  const { request } = useTransport();
  const su = useSuperuser();
  const toast = useToast();

  const [d, setD] = useState<TimeSyncData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState('');

  const gated = !su.active;

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    request('timesync.manage', { daemon })
      .then((results) => {
        const data = results[0] as TimeSyncData | undefined;
        if (data) {
          setD(data);
          setRaw(data.config_raw ?? '');
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [request, daemon]);

  useEffect(() => { load(); }, [load]);

  const runAction = useCallback(
    async (params: Record<string, unknown>, okMsg: string) => {
      setBusy(true);
      try {
        const [res] = await request('timesync.manage', { daemon, ...params, password: su.password });
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
    [request, daemon, su.password, toast, load],
  );

  if (loading && !d) return <p style={{ color: 'var(--text-2)' }}>Loading…</p>;
  if (error) return <p style={{ color: 'var(--c-red)' }}>Error: {error}</p>;
  if (d && !d.available) return <p style={{ color: 'var(--text-2)' }}>{daemon} is not available on this host.</p>;

  const rawDirty = raw !== (d?.config_raw ?? '');

  return (
    <div>
      {gated && (
        <p style={S.notice}>
          Enable <b>superuser</b> mode (top bar) to restart the service or edit its config.
        </p>
      )}

      <div style={S.toolbar}>
        <button style={S.btn} onClick={load} disabled={loading}>Refresh</button>
        <span style={{ flex: 1 }} />
        <Badge color={d?.active ? 'var(--c-green)' : 'var(--c-red)'}>{d?.active ? 'active' : 'inactive'}</Badge>
        <Badge color={d?.enabled ? 'var(--c-green)' : 'var(--text-3)'}>{d?.enabled ? 'enabled' : 'disabled'}</Badge>
        <button style={cmdStyle(gated || busy)} disabled={gated || busy}
          onClick={() => runAction({ action: 'set_enabled', enabled: !d?.enabled }, d?.enabled ? 'Disabled at boot.' : 'Enabled at boot.')}>
          {d?.enabled ? 'Disable' : 'Enable'}
        </button>
        <button style={cmdStyle(gated || busy)} disabled={gated || busy}
          onClick={() => runAction({ action: 'restart' }, 'Service restarted.')}>Restart</button>
      </div>

      {/* Status */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>{d?.label ?? daemon} — status</h3>
        <div style={S.metaRow}>
          <span style={S.meta}>unit: <b style={S.mono}>{d?.unit}</b></span>
          {d?.config_path && <span style={S.meta}>config: <b style={S.mono}>{d.config_path}</b></span>}
        </div>
        <div style={S.statusLabel}>{d?.status_label}</div>
        <pre style={S.pre}>{d?.status_text || '(no output)'}</pre>
      </div>

      {/* Config */}
      <div style={S.card}>
        <h3 style={S.cardTitle}>Configuration {d?.config_path ? `(${d.config_path})` : ''}</h3>
        {d?.config_editable ? (
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
                onClick={() => runAction({ action: 'save_config', content: raw }, 'Config saved & service restarted.')}>
                Save &amp; restart
              </button>
            </div>
          </>
        ) : (
          <p style={{ color: 'var(--text-2)', fontSize: '0.85rem', margin: 0 }}>
            {d?.config_path
              ? 'This configuration is read-only here.'
              : `${d?.label ?? daemon} has no standard editable config file (configured via service arguments).`}
          </p>
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
  metaRow: { display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.6rem', fontSize: '0.82rem', color: 'var(--text-2)' },
  meta: { whiteSpace: 'nowrap' },
  mono: { fontFamily: 'monospace', color: 'var(--text-1)' },
  statusLabel: { fontSize: '0.72rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.35rem' },
  pre: { margin: 0, padding: '0.6rem', borderRadius: 6, background: 'var(--bg-app)', color: 'var(--text-1)', fontFamily: 'monospace', fontSize: '0.78rem', overflowX: 'auto', whiteSpace: 'pre', maxHeight: 340 },
  rowActions: { display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' },
  btnGhost: { padding: '0.4rem 0.9rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.83rem' },
  saveOn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.83rem' },
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
  textarea: { width: '100%', boxSizing: 'border-box', marginTop: '0.25rem', padding: '0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-app)', color: 'var(--text-1)', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' },
};
