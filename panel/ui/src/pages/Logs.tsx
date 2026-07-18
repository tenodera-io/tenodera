import { useEffect, useState, useCallback, useRef } from 'react';
import { PageHeader } from '../components/PageHeader.tsx';
import { RestrictedNotice } from '../components/RestrictedNotice.tsx';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';

interface LogEntry {
  MESSAGE?: string | number[];
  PRIORITY?: string;
  _SYSTEMD_UNIT?: string;
  __REALTIME_TIMESTAMP?: string;
  [key: string]: unknown;
}

export function Logs() {
  const { request } = useTransport();
  const su = useSuperuser();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [lines, setLines] = useState(100);
  const [unit, setUnit] = useState('');
  const [debouncedUnit, setDebouncedUnit] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [restricted, setRestricted] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounce unit filter — wait 400ms after last keystroke
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedUnit(unit), 400);
    return () => clearTimeout(debounceRef.current);
  }, [unit]);

  const fetchLogs = useCallback(() => {
    const opts: Record<string, unknown> = { lines };
    if (debouncedUnit) opts.unit = debouncedUnit;
    // Superuser mode escalates via `sudo journalctl` on the host (host sudoers decides).
    if (su.active && su.password) opts.password = su.password;

    setLoading(true);
    setError('');
    // Reads run as the logged-in user on the host — the host's group ACLs decide what
    // is visible. `restricted` is expected (not an error) when access is limited.
    request('journal.query', opts).then((results) => {
      const data = results[0] as
        | { entries?: LogEntry[]; restricted?: boolean; reason?: string; error?: string }
        | undefined;
      setEntries(data?.entries ?? []);
      setRestricted(data?.restricted ? data.reason ?? 'restricted' : null);
      // A genuine failure (e.g. wrong sudo password) — restricted is handled separately.
      setError(!data?.restricted && data?.error ? data.error : '');
    }).catch((e) => {
      setError(e instanceof Error ? e.message : 'Failed to load logs');
    }).finally(() => {
      setLoading(false);
    });
  }, [request, lines, debouncedUnit, su]);

  useEffect(() => {
    setEntries([]);
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div>
      <PageHeader icon="logs" title="Journal Logs" />
      <div style={styles.controls}>
        <input
          type="text"
          placeholder="Filter by unit (e.g. sshd)"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          style={{ ...styles.input, borderColor: unit ? 'var(--c-blue)' : 'var(--c-green)' }}
        />
        <select
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
          style={{ ...styles.select, borderColor: 'var(--c-blue)' }}
        >
          <option value={50}>50 lines</option>
          <option value={100}>100 lines</option>
          <option value={500}>500 lines</option>
        </select>
        <button onClick={fetchLogs} disabled={loading} style={styles.btn}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && <p style={styles.error}>{error}</p>}
      {restricted && <RestrictedNotice reason={restricted} what="the system journal" />}
      <div style={styles.logContainer}>
        {entries.map((entry, i) => (
          <div key={i} style={styles.logLine}>
            <span style={styles.timestamp}>{formatTimestamp(entry.__REALTIME_TIMESTAMP)}</span>
            <span style={priorityStyle(entry.PRIORITY)}>
              {priorityLabel(entry.PRIORITY)}
            </span>
            <span style={styles.unit}>{entry._SYSTEMD_UNIT || '—'}</span>
            <span>{decodeMessage(entry.MESSAGE)}</span>
          </div>
        ))}
        {entries.length === 0 && !loading && !error && !restricted && <p style={{ color: 'var(--text-2)', padding: '0.5rem' }}>No log entries.</p>}
      </div>
    </div>
  );
}

function priorityLabel(p?: string): string {
  const map: Record<string, string> = {
    '0': 'EMRG',
    '1': 'ALRT',
    '2': 'CRIT',
    '3': 'ERR ',
    '4': 'WARN',
    '5': 'NTCE',
    '6': 'INFO',
    '7': 'DBG ',
  };
  return map[p || '6'] || 'INFO';
}

/** Decode MESSAGE field — journalctl --output=json encodes binary messages as byte arrays. */
function decodeMessage(msg?: string | number[]): string {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) {
    // Strip ANSI escape sequences after decoding
    const raw = new TextDecoder().decode(new Uint8Array(msg));
    return raw.replace(/\x1b\[[0-9;]*m/g, '');
  }
  return String(msg);
}

/** Format __REALTIME_TIMESTAMP (microseconds since epoch) to local time. */
function formatTimestamp(ts?: string): string {
  if (!ts) return '—';
  const ms = Math.floor(Number(ts) / 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function priorityStyle(p?: string): React.CSSProperties {
  const num = Number(p || 6);
  const color = num <= 3 ? 'var(--c-red)' : num <= 4 ? 'var(--c-orange)' : 'var(--text-3)';
  return {
    color,
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    marginRight: '0.5rem',
    minWidth: '3rem',
  };
}

const styles: Record<string, React.CSSProperties> = {
  controls: {
    display: 'flex',
    gap: '0.5rem',
    margin: '1rem 0',
    flexWrap: 'wrap',
  },
  input: {
    padding: '0.5rem',
    borderRadius: '4px',
    border: '1px solid var(--c-green)',
    background: 'var(--bg-panel)',
    color: 'var(--text-1)',
    flex: 1,
    minWidth: '200px',
  },
  select: {
    padding: '0.5rem',
    borderRadius: '4px',
    border: '1px solid var(--c-green)',
    background: 'var(--bg-panel)',
    color: 'var(--text-1)',
  },
  btn: {
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--c-blue)',
    color: 'var(--bg-app)',
    cursor: 'pointer',
  },
  logContainer: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    maxHeight: 'calc(100vh - 250px)',
    overflow: 'auto',
    background: 'var(--bg-panel)',
    borderRadius: '8px',
    padding: '0.5rem',
  },
  logLine: {
    padding: '2px 4px',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  unit: {
    color: 'var(--c-blue)',
    marginRight: '0.5rem',
    fontSize: '0.8rem',
  },
  timestamp: {
    color: 'var(--text-2)',
    marginRight: '0.5rem',
    fontSize: '0.8rem',
    minWidth: '4.5rem',
  },
  error: {
    color: 'var(--c-red)',
    fontSize: '0.85rem',
    margin: '0.25rem 0 0.5rem',
  },
};
