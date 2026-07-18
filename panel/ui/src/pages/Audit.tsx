import { useEffect, useState, useCallback } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { useTransport } from '../api/HostTransportContext.tsx';

interface AuditEntry {
  ts: string;
  user: string;
  action: string;
  target: string;
  result: string;
  details: string;
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function Audit() {
  const { request } = useTransport();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    request('audit.query', { limit: 1000 })
      .then((r) => {
        const d = r[0] as { entries?: AuditEntry[]; total?: number; error?: string } | undefined;
        if (d?.error) { setError(d.error); return; }
        setEntries(d?.entries ?? []);
        setTotal(d?.total ?? 0);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const q = filter.trim().toLowerCase();
  const rows = q
    ? entries.filter((e) => [e.user, e.action, e.target, e.result, e.details].some((f) => (f || '').toLowerCase().includes(q)))
    : entries;

  return (
    <div style={S.page}>
      <PageHeader
        icon="audit"
        title="Audit log"
        actions={
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input style={S.input} placeholder="Filter user, action, target…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button style={S.btn} onClick={load} disabled={loading}>Refresh</button>
          </div>
        }
      />

      {error && <p style={{ color: 'var(--c-red)' }}>Error: {error}</p>}

      {loading && entries.length === 0 ? (
        <p style={S.muted}>Loading…</p>
      ) : (
        <div style={S.tableWrap}>
          <div style={S.scroll}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Time</th>
                  <th style={S.th}>User</th>
                  <th style={S.th}>Action</th>
                  <th style={S.th}>Target</th>
                  <th style={S.th}>Result</th>
                  <th style={S.th}>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, i) => (
                  <tr key={i}>
                    <td style={{ ...S.td, whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.78rem' }}>{fmtTs(e.ts)}</td>
                    <td style={S.td}>{e.user || '—'}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{e.action}</td>
                    <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-2)' }}>{e.target || '—'}</td>
                    <td style={S.td}><span style={{ color: e.result === 'ok' ? 'var(--c-green)' : 'var(--c-red)', fontWeight: 600 }}>{e.result}</span></td>
                    <td style={{ ...S.td, color: 'var(--text-2)' }}>{e.details || '—'}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td style={S.td} colSpan={6}><span style={S.muted}>No audit entries.</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p style={S.footer}>{rows.length} of {total} entries · /var/log/tenodera_audit.log (newest first)</p>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 },
  tableWrap: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  scroll: { flex: 1, overflow: 'auto', minHeight: 0, borderRadius: 8, border: '1px solid var(--border)' },
  footer: { color: 'var(--text-2)', fontSize: '0.85rem', margin: '0.6rem 0 0' },
  muted: { color: 'var(--text-2)', fontSize: '0.85rem' },
  btn: { padding: '0.4rem 0.9rem', borderRadius: 5, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.83rem' },
  input: { padding: '0.4rem 0.6rem', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none', width: 220 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem', minWidth: 760 },
  th: { position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', padding: '0.6rem 0.6rem', background: 'var(--bg-panel)', borderBottom: '2px solid var(--border)', color: 'var(--text-1)', fontWeight: 700, fontSize: '0.92rem', whiteSpace: 'nowrap' },
  td: { padding: '0.4rem 0.5rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top' },
};
