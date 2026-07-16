import React, { useEffect, useState, useCallback, useContext } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { useTransport } from '../api/HostTransportContext.tsx';
import { SuperuserContext } from '../api/SuperuserContext.tsx';
import { RoleContext } from '../contexts/RoleContext.ts';

interface CronEntry {
  schedule: string;
  user: string;
  command: string;
  comment: string;
}

interface CronSource {
  source: string;
  path: string;
  source_type: 'system_file' | 'user_crontab';
  user: string | null;
  content: string;
  entries: CronEntry[];
}

const SPECIALS: Record<string, string> = {
  '@reboot': 'At boot',
  '@hourly': 'Every hour',
  '@daily': 'Daily',
  '@midnight': 'Daily (midnight)',
  '@weekly': 'Weekly',
  '@monthly': 'Monthly',
  '@yearly': 'Yearly',
  '@annually': 'Yearly',
};

function describeCron(schedule: string): string {
  const lower = schedule.toLowerCase();
  if (SPECIALS[lower]) return SPECIALS[lower];
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, dom, month, dow] = parts;
  if (dom === '*' && month === '*' && dow === '*') {
    if (hour === '*') return `Every ${min === '*' ? 'minute' : `${min} min past every hour`}`;
    if (min === '0') return `Daily at ${hour.padStart(2, '0')}:00`;
    if (!min.includes('*') && !min.includes(',') && !min.includes('/'))
      return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (hour.startsWith('*/')) return `Every ${hour.slice(2)}h`;
  }
  return schedule;
}

function sourceLabel(src: CronSource): string {
  if (src.source_type === 'user_crontab') return `User: ${src.user}`;
  return src.source;
}

export function Cron() {
  const [sources, setSources] = useState<CronSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CronSource | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const { request } = useTransport();
  const su = useContext(SuperuserContext);
  const role = useContext(RoleContext);
  const isAdmin = role === 'admin';

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    request('cron.list', {})
      .then((results) => {
        const data = results[0] as { sources?: CronSource[] } | undefined;
        setSources(data?.sources ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [request]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (src: CronSource) => {
    setEditing(src);
    setEditContent(src.content);
    setSaveError('');
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setSaveError('');
    try {
      const payload: Record<string, unknown> =
        editing.source_type === 'user_crontab'
          ? { action: 'set_user_crontab', target_user: editing.user, content: editContent, password: su.password }
          : { action: 'write_system_file', path: editing.path, content: editContent, password: su.password };

      const results = await request('cron.manage', payload);
      const res = results[0] as { ok?: boolean; error?: string } | undefined;
      if (res?.ok) {
        setEditing(null);
        load();
      } else {
        setSaveError(res?.error || 'Save failed');
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const totalJobs = sources.reduce((s, src) => s + src.entries.length, 0);

  return (
    <div>
      <PageHeader
        icon="cron"
        title="Cron Jobs"
        actions={
          <>
            {!loading && <span style={S.subtitle}>{totalJobs} job{totalJobs !== 1 ? 's' : ''} across {sources.length} source{sources.length !== 1 ? 's' : ''}</span>}
            <button style={S.refreshBtn} onClick={load} title="Refresh">&#x21BB;</button>
          </>
        }
      />

      {loading && <div style={S.msg}>Loading...</div>}
      {error && <div style={{ ...S.msg, color: 'var(--c-red)' }}>{error}</div>}
      {!loading && !error && sources.length === 0 && (
        <div style={S.msg}>No cron jobs found.</div>
      )}

      {sources.map(src => (
        <div key={src.source} style={S.card}>
          <div style={S.cardHeader}>
            <div>
              <span style={S.cardTitle}>{sourceLabel(src)}</span>
              <span style={S.cardCount}>{src.entries.length} job{src.entries.length !== 1 ? 's' : ''}</span>
            </div>
            {isAdmin && (
              <button style={S.editBtn} onClick={() => startEdit(src)}>Edit</button>
            )}
          </div>

          {src.entries.length === 0 ? (
            <div style={S.emptySource}>No active jobs (file may contain only comments)</div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Schedule</th>
                  <th style={S.th}>Description</th>
                  <th style={S.th}>User</th>
                  <th style={S.th}>Command</th>
                </tr>
              </thead>
              <tbody>
                {src.entries.map((e, i) => (
                  <tr key={i} style={i % 2 === 0 ? S.rowEven : S.rowOdd}>
                    <td style={{ ...S.td, ...S.tdMono, whiteSpace: 'nowrap' }}>{e.schedule}</td>
                    <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.75rem' }}>{describeCron(e.schedule)}</td>
                    <td style={{ ...S.td, ...S.tdMono }}>{e.user}</td>
                    <td style={{ ...S.td, ...S.tdMono, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.command}>{e.command}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      {/* ── Edit modal ── */}
      {editing && (
        <div style={S.overlay} onClick={() => setEditing(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <span style={S.modalTitle}>Edit — {sourceLabel(editing)}</span>
              <button style={S.closeBtn} onClick={() => setEditing(null)}>&#x2715;</button>
            </div>
            <textarea
              style={S.textarea}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              spellCheck={false}
            />
            {saveError && <div style={S.saveError}>{saveError}</div>}
            {!su.active && (
              <div style={S.noSu}>Root Access required to save changes.</div>
            )}
            <div style={S.modalActions}>
              <button style={S.cancelBtn} onClick={() => setEditing(null)}>Cancel</button>
              <button
                style={{ ...S.saveBtn, opacity: (!su.active || saving) ? 0.5 : 1 }}
                onClick={save}
                disabled={!su.active || saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  header:      { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' },
  title:       { fontSize: '1.3rem', fontWeight: 700, margin: 0 },
  subtitle:    { fontSize: '0.8rem', color: 'var(--text-2)' },
  refreshBtn:  { padding: '0.4rem 0.7rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '1rem' },
  msg:         { textAlign: 'center', padding: '3rem', color: 'var(--text-2)' },
  card:        { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: '1rem', overflow: 'hidden' },
  cardHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' },
  cardTitle:   { fontWeight: 700, fontSize: '0.9rem', fontFamily: 'monospace' },
  cardCount:   { marginLeft: '0.6rem', fontSize: '0.75rem', color: 'var(--text-2)' },
  editBtn:     { padding: '0.3rem 0.75rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--c-blue)', cursor: 'pointer', fontSize: '0.8rem' },
  emptySource: { padding: '0.75rem 0.9rem', fontSize: '0.8rem', color: 'var(--text-2)' },
  table:       { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' },
  th:          { padding: '0.4rem 0.75rem', textAlign: 'left', fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-2)', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' },
  td:          { padding: '0.4rem 0.75rem', verticalAlign: 'middle' },
  tdMono:      { fontFamily: 'monospace', fontSize: '0.8rem' },
  rowEven:     { background: 'transparent' },
  rowOdd:      { background: 'rgba(255,255,255,0.02)' },
  overlay:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal:       { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 10, width: 720, maxWidth: '95vw', display: 'flex', flexDirection: 'column', maxHeight: '85vh' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' },
  modalTitle:  { fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9rem' },
  closeBtn:    { background: 'transparent', border: 'none', color: 'var(--text-2)', cursor: 'pointer', fontSize: '1rem', padding: '0 0.3rem' },
  textarea:    { flex: 1, margin: '0.75rem', background: 'var(--bg-app)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-2)', fontFamily: 'monospace', fontSize: '0.82rem', padding: '0.6rem', resize: 'vertical', minHeight: 280, outline: 'none' },
  saveError:   { margin: '0 0.75rem', color: 'var(--c-red)', fontSize: '0.8rem' },
  noSu:        { margin: '0.25rem 0.75rem', color: 'var(--c-yellow)', fontSize: '0.8rem' },
  modalActions:{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', padding: '0.75rem 1rem', borderTop: '1px solid var(--border)' },
  cancelBtn:   { padding: '0.4rem 1rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.85rem' },
  saveBtn:     { padding: '0.4rem 1.2rem', borderRadius: 6, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 },
};
