import { useEffect, useState } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';

interface LogEntry {
  MESSAGE?: string | number[];
  PRIORITY?: string;
  _SYSTEMD_UNIT?: string;
  __REALTIME_TIMESTAMP?: string;
  [key: string]: unknown;
}

export function Logs() {
  const { request } = useTransport();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [lines, setLines] = useState(100);
  const [unit, setUnit] = useState('');

  const fetchLogs = () => {
    const opts: Record<string, unknown> = { lines };
    if (unit) opts.unit = unit;

    request('journal.query', opts).then((results) => {
      const data = results[0] as { entries: LogEntry[] } | undefined;
      if (data?.entries) setEntries(data.entries);
    });
  };

  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h2>Journal Logs</h2>
      <div style={styles.controls}>
        <input
          type="text"
          placeholder="Filter by unit (e.g. sshd)"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          style={{ ...styles.input, borderColor: unit ? '#7aa2f7' : '#9ece6a' }}
        />
        <select
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
          style={{ ...styles.select, borderColor: '#7aa2f7' }}
        >
          <option value={50}>50 lines</option>
          <option value={100}>100 lines</option>
          <option value={500}>500 lines</option>
        </select>
        <button onClick={fetchLogs} style={styles.btn}>
          Refresh
        </button>
      </div>
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
        {entries.length === 0 && <p>No log entries.</p>}
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
  const color = num <= 3 ? '#f44336' : num <= 4 ? '#ff9800' : '#888';
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
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    flex: 1,
    minWidth: '200px',
  },
  select: {
    padding: '0.5rem',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  },
  btn: {
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
  },
  logContainer: {
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    maxHeight: 'calc(100vh - 250px)',
    overflow: 'auto',
    background: 'var(--bg-secondary)',
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
    color: 'var(--accent)',
    marginRight: '0.5rem',
    fontSize: '0.8rem',
  },
  timestamp: {
    color: 'var(--text-secondary)',
    marginRight: '0.5rem',
    fontSize: '0.8rem',
    minWidth: '4.5rem',
  },
};
