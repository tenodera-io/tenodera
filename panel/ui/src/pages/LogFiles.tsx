import { useEffect, useState, useRef, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import type { Message } from '../api/transport.ts';

/* ── types ─────────────────────────────────────────────── */

interface LogFile {
  path: string;
  name: string;
  size_bytes: number;
  modified: number;
}

interface GrepLineEntry {
  num: number;
  match: boolean;
  text: string;
}

interface GrepGroup {
  lines: GrepLineEntry[];
}

/* ── component ─────────────────────────────────────────── */

export function LogFiles() {
  const { openChannel } = useTransport();
  const su = useSuperuser();
  const suRef = useRef(su);
  suRef.current = su;

  // File list
  const [files, setFiles] = useState<LogFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [fileFilter, setFileFilter] = useState('');

  // Selected file
  const [selectedFile, setSelectedFile] = useState('');

  // Tail view
  const [tailLines, setTailLines] = useState<string[]>([]);
  const [tailCount, setTailCount] = useState(100);
  const [tailLoading, setTailLoading] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBefore, setSearchBefore] = useState(3);
  const [searchAfter, setSearchAfter] = useState(3);
  const [searchMaxLines, setSearchMaxLines] = useState(100);
  const [searchDateFrom, setSearchDateFrom] = useState('');
  const [searchTimeFrom, setSearchTimeFrom] = useState('');
  const [searchDateTo, setSearchDateTo] = useState('');
  const [searchTimeTo, setSearchTimeTo] = useState('');
  const [searchResults, setSearchResults] = useState<GrepGroup[]>([]);
  const [searchMatchCount, setSearchMatchCount] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);

  // View mode
  const [viewMode, setViewMode] = useState<'tail' | 'search'>('tail');
  const [error, setError] = useState('');

  // Persistent channel ref
  const channelRef = useRef<ReturnType<typeof openChannel> | null>(null);
  const readyRef = useRef(false);
  const pendingQueue = useRef<Record<string, unknown>[]>([]);
  const selectedFileRef = useRef('');
  const viewModeRef = useRef<'tail' | 'search'>('tail');

  // Keep refs in sync
  selectedFileRef.current = selectedFile;
  viewModeRef.current = viewMode;

  // Open persistent channel on mount — all commands go through data()
  useEffect(() => {
    const ch = openChannel('log.files');
    channelRef.current = ch;

    ch.onMessage((msg: Message) => {
      if (msg.type === 'ready') {
        readyRef.current = true;
        // Flush any commands queued before ready
        for (const cmd of pendingQueue.current) {
          ch.send(cmd);
        }
        pendingQueue.current = [];
        // Request file list once channel is ready (include password if superuser active)
        const currentSu = suRef.current;
        const listCmd: Record<string, unknown> = { action: 'list' };
        if (currentSu.active && currentSu.password) {
          listCmd.password = currentSu.password;
        }
        ch.send(listCmd);
      }
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as { type?: string; action?: string; data?: Record<string, unknown> };
        if (d.type !== 'response' || !d.data) return;

        switch (d.action) {
          case 'list':
          case 'refresh': {
            const files = d.data.files as LogFile[] | undefined;
            if (files) setFiles(files);
            setFilesLoading(false);
            break;
          }
          case 'tail': {
            const td = d.data as { ok?: boolean; lines?: string[]; error?: string };
            if (td.ok && td.lines) {
              setTailLines(td.lines);
            } else {
              setError(td.error || 'Failed to read log');
              setTailLines([]);
            }
            setTailLoading(false);
            break;
          }
          case 'filter': {
            const fd = d.data as {
              ok?: boolean;
              lines?: { num: number; text: string }[];
              total_lines?: number;
              error?: string;
            };
            if (fd.ok && fd.lines) {
              // Convert filter results into search-like display (one group)
              setSearchResults([{
                lines: fd.lines.map((l) => ({ num: l.num, match: true, text: l.text })),
              }]);
              setSearchMatchCount(fd.total_lines || fd.lines.length);
            } else {
              setError(fd.error || 'Filter failed');
              setSearchResults([]);
              setSearchMatchCount(0);
            }
            setSearchLoading(false);
            break;
          }
          case 'search': {
            const sd = d.data as {
              ok?: boolean;
              matches?: GrepGroup[];
              match_count?: number;
              error?: string;
            };
            if (sd.ok && sd.matches) {
              setSearchResults(sd.matches);
              setSearchMatchCount(sd.match_count || 0);
            } else {
              setError(sd.error || 'Search failed');
              setSearchResults([]);
              setSearchMatchCount(0);
            }
            setSearchLoading(false);
            break;
          }
        }
      }
      if (msg.type === 'close') {
        readyRef.current = false;
      }
    });

    return () => {
      ch.close();
      channelRef.current = null;
      readyRef.current = false;
      pendingQueue.current = [];
    };
  }, [openChannel]);

  // Helper: send command through persistent channel (injects superuser password)
  const send = useCallback((data: Record<string, unknown>) => {
    const currentSu = suRef.current;
    if (currentSu.active && currentSu.password) {
      data.password = currentSu.password;
    }
    if (readyRef.current && channelRef.current) {
      channelRef.current.send(data);
    } else {
      // Queue until ready
      pendingQueue.current.push(data);
    }
  }, []);

  // Load tail
  const loadTail = useCallback(() => {
    if (!selectedFileRef.current) return;
    setTailLoading(true);
    setError('');
    send({ action: 'tail', path: selectedFileRef.current, lines: tailCount });
  }, [tailCount, send]);

  // Build date string: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:00"
  const buildDateStr = useCallback((date: string, time: string) => {
    if (!date) return undefined;
    return time ? `${date} ${time}:00` : date;
  }, []);

  // Run search / filter
  // Rules:
  // 1. No date, no keyword → tail (handled by Tail tab)
  // 2. Date but no time → show logs from that day
  // 3. From (date+time) set, no To → from that moment to now, no max
  // 4. To (date+time) set, no From → everything until that moment, no max
  const runSearch = useCallback(() => {
    if (!selectedFileRef.current) return;

    const hasDateFrom = !!searchDateFrom;
    const hasDateTo = !!searchDateTo;
    const hasDate = hasDateFrom || hasDateTo;
    const hasQuery = !!searchQuery.trim();

    // Nothing to search/filter
    if (!hasQuery && !hasDate) return;

    setSearchLoading(true);
    setError('');
    setSearchResults([]);
    setSearchMatchCount(0);

    const dfrom = buildDateStr(searchDateFrom, searchTimeFrom);
    const dto = buildDateStr(searchDateTo, searchTimeTo);

    if (hasDate && !hasQuery) {
      // Date-only filter → use "filter" action (no grep, no max)
      const cmd: Record<string, unknown> = {
        action: 'filter',
        path: selectedFileRef.current,
      };
      if (dfrom) cmd.date_from = dfrom;
      if (dto) cmd.date_to = dto;
      send(cmd);
    } else {
      // Keyword search (optionally + date filter)
      const cmd: Record<string, unknown> = {
        action: 'search',
        path: selectedFileRef.current,
        query: searchQuery,
        lines: searchMaxLines,
        before: searchBefore,
        after: searchAfter,
      };
      if (dfrom) cmd.date_from = dfrom;
      if (dto) cmd.date_to = dto;
      send(cmd);
    }
  }, [searchQuery, searchMaxLines, searchBefore, searchAfter, searchDateFrom, searchTimeFrom, searchDateTo, searchTimeTo, send, buildDateStr]);

  const fetchFiles = useCallback(() => {
    setFilesLoading(true);
    send({ action: 'list' });
  }, [send]);

  // Re-list files when superuser status changes (reveals/hides restricted files)
  useEffect(() => {
    if (readyRef.current) {
      fetchFiles();
    }
  }, [su.active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-load tail when file selected
  useEffect(() => {
    if (selectedFile && viewMode === 'tail') {
      loadTail();
    }
  }, [selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter files
  const filteredFiles = files.filter(
    (f) =>
      !fileFilter ||
      f.path.toLowerCase().includes(fileFilter.toLowerCase()) ||
      f.name.toLowerCase().includes(fileFilter.toLowerCase()),
  );

  return (
    <div style={S.container}>
      <h2 style={{ margin: '0 0 1rem 0' }}>Log Files (/var/log)</h2>

      <div style={S.layout}>
        {/* ── Left: file list ──────────────────────────── */}
        <div style={S.sidebar}>
          <input
            type="text"
            placeholder="Filter files..."
            value={fileFilter}
            onChange={(e) => setFileFilter(e.target.value)}
            style={{ ...S.filterInput, borderColor: fileFilter ? '#7aa2f7' : '#9ece6a' }}
          />
          <div style={S.fileList}>
            {filesLoading ? (
              <p style={S.muted}>Loading...</p>
            ) : filteredFiles.length === 0 ? (
              <p style={S.muted}>No log files found</p>
            ) : (
              filteredFiles.map((f) => (
                <div
                  key={f.path}
                  style={{
                    ...S.fileItem,
                    ...(f.path === selectedFile ? S.fileItemActive : {}),
                  }}
                  onClick={() => setSelectedFile(f.path)}
                >
                  <div style={S.fileName}>{f.path.replace('/var/log/', '')}</div>
                  <div style={S.fileMeta}>{formatBytes(f.size_bytes)}</div>
                </div>
              ))
            )}
          </div>
          <button onClick={fetchFiles} style={S.btn}>
            Refresh list
          </button>
        </div>

        {/* ── Right: viewer ────────────────────────────── */}
        <div style={S.main}>
          {!selectedFile ? (
            <p style={S.muted}>Select a log file from the list</p>
          ) : (
            <>
              <div style={S.selectedPath}>{selectedFile}</div>

              {/* Mode tabs */}
              <div style={S.tabs}>
                <button
                  onClick={() => setViewMode('tail')}
                  style={viewMode === 'tail' ? S.tabActive : S.tab}
                >
                  Tail
                </button>
                <button
                  onClick={() => setViewMode('search')}
                  style={viewMode === 'search' ? S.tabActive : S.tab}
                >
                  Search
                </button>
              </div>

              {/* ── Tail controls ───────────────────────── */}
              {viewMode === 'tail' && (
                <>
                  <div style={S.controls}>
                    <label style={S.label}>
                      Lines:
                      <select
                        value={tailCount}
                        onChange={(e) => setTailCount(Number(e.target.value))}
                        style={{ ...S.select, borderColor: '#7aa2f7' }}
                      >
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={250}>250</option>
                        <option value={500}>500</option>
                        <option value={1000}>1000</option>
                        <option value={5000}>5000</option>
                      </select>
                    </label>
                    <button onClick={loadTail} style={S.btn} disabled={tailLoading}>
                      {tailLoading ? 'Loading...' : 'Load'}
                    </button>
                  </div>

                  {error && <p style={S.error}>{error}</p>}

                  <div style={S.logOutput}>
                    {tailLines.map((line, i) => (
                      <div key={i} style={S.logLine}>
                        <span style={S.lineNum}>{i + 1}</span>
                        <span>{line}</span>
                      </div>
                    ))}
                    {tailLines.length === 0 && !tailLoading && (
                      <p style={S.muted}>No data</p>
                    )}
                  </div>
                </>
              )}

              {/* ── Search controls ─────────────────────── */}
              {viewMode === 'search' && (
                <>
                  <div style={S.controls}>
                    <input
                      type="text"
                      placeholder="Search keyword..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                      style={{ ...S.input, flex: 2, minWidth: '200px', borderColor: searchQuery ? '#7aa2f7' : '#9ece6a' }}
                    />
                    <label style={S.label}>
                      Max:
                      <select
                        value={searchMaxLines}
                        onChange={(e) => setSearchMaxLines(Number(e.target.value))}
                        style={{ ...S.select, borderColor: '#7aa2f7' }}
                      >
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                        <option value={500}>500</option>
                        <option value={1000}>1000</option>
                      </select>
                    </label>
                  </div>

                  <div style={S.controls}>
                    <label style={S.label}>
                      Before:
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={searchBefore}
                        onChange={(e) => setSearchBefore(Number(e.target.value))}
                        style={{ ...S.input, width: '60px', borderColor: '#7aa2f7' }}
                      />
                    </label>
                    <label style={S.label}>
                      After:
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={searchAfter}
                        onChange={(e) => setSearchAfter(Number(e.target.value))}
                        style={{ ...S.input, width: '60px', borderColor: '#7aa2f7' }}
                      />
                    </label>
                    <label style={S.label}>
                      From:
                      <input
                        type="date"
                        value={searchDateFrom}
                        onChange={(e) => setSearchDateFrom(e.target.value)}
                        style={{ ...S.input, borderColor: searchDateFrom ? '#7aa2f7' : '#9ece6a' }}
                      />
                      <input
                        type="time"
                        value={searchTimeFrom}
                        onChange={(e) => setSearchTimeFrom(e.target.value)}
                        style={{ ...S.input, width: '100px', borderColor: searchTimeFrom ? '#7aa2f7' : '#9ece6a' }}
                      />
                    </label>
                    <label style={S.label}>
                      To:
                      <input
                        type="date"
                        value={searchDateTo}
                        onChange={(e) => setSearchDateTo(e.target.value)}
                        style={{ ...S.input, borderColor: searchDateTo ? '#7aa2f7' : '#9ece6a' }}
                      />
                      <input
                        type="time"
                        value={searchTimeTo}
                        onChange={(e) => setSearchTimeTo(e.target.value)}
                        style={{ ...S.input, width: '100px', borderColor: searchTimeTo ? '#7aa2f7' : '#9ece6a' }}
                      />
                    </label>
                    <button onClick={runSearch} style={S.btn} disabled={searchLoading || (!searchQuery && !searchDateFrom && !searchDateTo)}>
                      {searchLoading ? 'Searching...' : 'Search'}
                    </button>
                  </div>

                  {error && <p style={S.error}>{error}</p>}

                  {searchMatchCount > 0 && (
                    <p style={S.matchInfo}>
                      {searchMatchCount} {searchQuery ? 'match group' : 'line'}{searchMatchCount !== 1 ? 's' : ''} found
                    </p>
                  )}

                  <div style={S.logOutput}>
                    {searchResults.map((group, gi) => (
                      <div key={gi} style={S.searchGroup}>
                        {group.lines.map((entry, li) => (
                          <div
                            key={li}
                            style={{
                              ...S.logLine,
                              ...(entry.match ? S.matchLine : S.contextLine),
                            }}
                          >
                            <span style={S.lineNum}>{entry.num}</span>
                            <HighlightedText text={entry.text} query={searchQuery} />
                          </div>
                        ))}
                        {gi < searchResults.length - 1 && <div style={S.groupSep}>···</div>}
                      </div>
                    ))}
                    {searchResults.length === 0 && !searchLoading && (
                      <p style={S.muted}>
                        {searchQuery || searchDateFrom || searchDateTo
                          ? 'No matches found'
                          : 'Enter a search query or set a date range'}
                      </p>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Highlight component ───────────────────────────────── */

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <span>{text}</span>;

  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  let lastIdx = 0;

  while (true) {
    const idx = lower.indexOf(qLower, lastIdx);
    if (idx === -1) break;
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
    parts.push(
      <mark key={idx} style={S.highlight}>
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    lastIdx = idx + query.length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));

  return <span>{parts}</span>;
}

/* ── helpers ───────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ── styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  layout: {
    display: 'flex',
    gap: '1rem',
    flex: 1,
    minHeight: 0,
  },
  sidebar: {
    width: '280px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  filterInput: {
    padding: '0.5rem',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
  },
  fileList: {
    flex: 1,
    overflow: 'auto',
    background: 'var(--bg-secondary)',
    borderRadius: '8px',
    maxHeight: 'calc(100vh - 220px)',
  },
  fileItem: {
    padding: '0.4rem 0.6rem',
    cursor: 'pointer',
    borderBottom: '1px solid var(--border)',
    fontSize: '0.82rem',
    transition: 'background 0.1s',
  },
  fileItemActive: {
    background: 'var(--accent)',
    color: '#fff',
  },
  fileName: {
    fontWeight: 500,
    wordBreak: 'break-all' as const,
  },
  fileMeta: {
    fontSize: '0.75rem',
    opacity: 0.7,
    marginTop: '2px',
  },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  selectedPath: {
    fontFamily: 'monospace',
    fontSize: '0.9rem',
    color: 'var(--accent)',
    marginBottom: '0.5rem',
    fontWeight: 600,
  },
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    marginBottom: '0.75rem',
  },
  tab: {
    padding: '0.4rem 1rem',
    borderRadius: '4px 4px 0 0',
    border: '1px solid var(--border)',
    borderBottom: 'none',
    background: 'var(--bg-secondary)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  tabActive: {
    padding: '0.4rem 1rem',
    borderRadius: '4px 4px 0 0',
    border: '1px solid var(--accent)',
    borderBottom: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 600,
  },
  controls: {
    display: 'flex',
    gap: '0.5rem',
    marginBottom: '0.5rem',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
  },
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.3rem',
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap' as const,
  },
  input: {
    padding: '0.4rem',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
  },
  select: {
    padding: '0.4rem',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
  },
  btn: {
    padding: '0.4rem 1rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap' as const,
  },
  logOutput: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
    flex: 1,
    overflow: 'auto',
    background: 'var(--bg-secondary)',
    borderRadius: '8px',
    padding: '0.5rem',
    maxHeight: 'calc(100vh - 340px)',
  },
  logLine: {
    padding: '1px 4px',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
    display: 'flex',
    gap: '0.5rem',
  },
  lineNum: {
    color: 'var(--text-secondary)',
    opacity: 0.5,
    minWidth: '40px',
    textAlign: 'right' as const,
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  matchLine: {
    background: 'rgba(255, 200, 50, 0.12)',
    borderLeft: '3px solid var(--warning, #c80)',
    paddingLeft: '6px',
  },
  contextLine: {
    opacity: 0.7,
  },
  searchGroup: {
    marginBottom: '0.25rem',
  },
  groupSep: {
    textAlign: 'center' as const,
    color: 'var(--text-secondary)',
    opacity: 0.4,
    padding: '0.25rem 0',
    fontSize: '0.9rem',
  },
  highlight: {
    background: 'rgba(255, 200, 50, 0.4)',
    color: 'inherit',
    borderRadius: '2px',
    padding: '0 1px',
  },
  matchInfo: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    margin: '0 0 0.5rem 0',
  },
  error: {
    color: 'var(--danger, #e55)',
    fontSize: '0.85rem',
    margin: '0.25rem 0',
  },
  muted: {
    color: 'var(--text-secondary)',
    padding: '1rem',
  },
};
