import { useEffect, useRef, useState, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import type { Message } from '../api/transport.ts';

interface DuEntry { name: string; size: number; is_dir: boolean }
interface DuResult {
  path: string;
  parent: string | null;
  total: number;
  entries: DuEntry[];
  truncated: boolean;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function StorageUsage() {
  const { openChannel } = useTransport();
  const [input, setInput] = useState('/');
  const [result, setResult] = useState<DuResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const chRef = useRef<ReturnType<typeof openChannel> | null>(null);
  const gotDataRef = useRef(false);

  const closeChannel = useCallback(() => {
    chRef.current?.close();
    chRef.current = null;
  }, []);

  useEffect(() => () => closeChannel(), [closeChannel]);

  const scan = useCallback((path: string) => {
    closeChannel();
    setLoading(true);
    setNotice(null);
    gotDataRef.current = false;

    const ch = openChannel('storage.du', { path });
    chRef.current = ch;
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data') {
        const d = msg.data as (DuResult & { error?: string });
        gotDataRef.current = true;
        if (d.error) { setNotice(d.error); setLoading(false); return; }
        setResult(d);
        setInput(d.path);
        setLoading(false);
      } else if (msg.type === 'close') {
        setLoading(false);
        if (!gotDataRef.current) {
          setNotice('Scan was cancelled or timed out (directory too large). Try a more specific path.');
        }
      }
    });
  }, [openChannel, closeChannel]);

  const cancel = () => {
    closeChannel();
    setLoading(false);
    setNotice('Scan cancelled.');
  };

  const total = result?.total ?? 0;

  return (
    <div>
      <div style={S.bar}>
        <input
          style={S.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !loading) scan(input.trim() || '/'); }}
          placeholder="/var"
          spellCheck={false}
        />
        {loading ? (
          <button style={S.btnCancel} onClick={cancel}>Cancel</button>
        ) : (
          <button style={S.btn} onClick={() => scan(input.trim() || '/')}>Scan</button>
        )}
        {result && result.parent && !loading && (
          <button style={S.btnGhost} onClick={() => scan(result.parent!)} title="Parent directory">↑ Up</button>
        )}
      </div>

      <p style={S.hint}>
        One level at a time, stays on one filesystem, runs at idle I/O priority with a 60s cap — safe on large disks. Click a folder to drill in.
      </p>

      {notice && <div style={S.notice}>{notice}</div>}

      {loading && (
        <div style={S.loading}>
          <span style={S.spinner} /> Scanning {input}… <span style={S.muted}>(cancel anytime)</span>
        </div>
      )}

      {result && !loading && (
        <div style={S.card}>
          <div style={S.head}>
            <span style={S.path}>{result.path}</span>
            <span style={S.totalBadge}>{fmtSize(total)}</span>
          </div>
          <table style={S.table}>
            <tbody>
              {result.entries.map((e) => {
                const pct = total > 0 ? (e.size / total) * 100 : 0;
                return (
                  <tr key={(e.is_dir ? 'd:' : 'f:') + e.name}>
                    <td style={S.tdIcon}>{e.is_dir ? '📁' : '📄'}</td>
                    <td style={S.tdName}>
                      {e.is_dir ? (
                        <button style={S.dirLink} onClick={() => scan(joinPath(result.path, e.name))}>{e.name}</button>
                      ) : (
                        <span style={S.fileName}>{e.name}</span>
                      )}
                    </td>
                    <td style={S.tdBar}>
                      <div style={S.barTrack}><div style={{ ...S.barFill, width: `${Math.max(pct, 0.5)}%` }} /></div>
                    </td>
                    <td style={S.tdPct}>{pct.toFixed(1)}%</td>
                    <td style={S.tdSize}>{fmtSize(e.size)}</td>
                  </tr>
                );
              })}
              {result.entries.length === 0 && (
                <tr><td colSpan={5} style={S.empty}>Empty (or nothing readable here).</td></tr>
              )}
            </tbody>
          </table>
          {result.truncated && <p style={S.muted}>List truncated to the largest 300 items.</p>}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' },
  input: { flex: '1 1 260px', minWidth: 200, padding: '0.45rem 0.65rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.9rem', fontFamily: 'monospace', outline: 'none' },
  btn: { padding: '0.45rem 1rem', borderRadius: 6, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' },
  btnCancel: { padding: '0.45rem 1rem', borderRadius: 6, border: 'none', background: 'var(--c-red)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem' },
  btnGhost: { padding: '0.45rem 0.9rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.85rem' },
  hint: { color: 'var(--text-2)', fontSize: '0.78rem', margin: '0 0 1rem' },
  notice: { padding: '0.6rem 0.85rem', borderRadius: 6, background: 'color-mix(in srgb, var(--c-orange) 12%, var(--bg-surface))', border: '1px solid color-mix(in srgb, var(--c-orange) 30%, transparent)', color: 'color-mix(in srgb, var(--c-orange) 82%, var(--text-1))', fontSize: '0.83rem', marginBottom: '1rem' },
  loading: { display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-1)', fontSize: '0.88rem', padding: '1rem 0' },
  spinner: { width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--c-blue)', display: 'inline-block', animation: 'spin 0.8s linear infinite' },
  card: { background: 'var(--bg-panel)', borderRadius: 8, padding: '0.85rem 1rem' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem', gap: '0.75rem' },
  path: { fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--text-1)', wordBreak: 'break-all' },
  totalBadge: { fontWeight: 700, fontSize: '0.9rem', color: 'var(--c-blue)', whiteSpace: 'nowrap' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' },
  tdIcon: { width: 26, padding: '0.35rem 0.25rem', borderBottom: '1px solid var(--border)' },
  tdName: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', wordBreak: 'break-all' },
  tdBar: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', width: '30%' },
  tdPct: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', textAlign: 'right', color: 'var(--text-2)', whiteSpace: 'nowrap', width: 60 },
  tdSize: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border)', textAlign: 'right', fontFamily: 'monospace', whiteSpace: 'nowrap', width: 90 },
  dirLink: { background: 'none', border: 'none', padding: 0, color: 'var(--c-blue)', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'left', fontFamily: 'inherit' },
  fileName: { color: 'var(--text-1)' },
  barTrack: { height: 8, borderRadius: 4, background: 'var(--bg-surface)', overflow: 'hidden' },
  barFill: { height: '100%', background: 'var(--c-blue)', borderRadius: 4 },
  empty: { padding: '0.6rem 0.5rem', color: 'var(--text-2)' },
  muted: { color: 'var(--text-2)', fontSize: '0.8rem' },
};
