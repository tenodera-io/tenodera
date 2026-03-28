import { useEffect, useState, useRef, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from './Shell.tsx';

interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'unknown';
  size: number;
}

interface FilesProps {
  user: string;
}

export function Files({ user }: FilesProps) {
  const { request } = useTransport();
  const su = useSuperuser();
  const homeDir = user ? `/home/${user}` : '/';
  const [path, setPath] = useState(homeDir);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(homeDir);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suRef = useRef(su);
  suRef.current = su;

  const fetchDir = useCallback((dirPath: string) => {
    const opts: Record<string, string> = { path: dirPath };
    const currentSu = suRef.current;
    if (currentSu.active && currentSu.password) opts.password = currentSu.password;
    request('file.list', opts).then((results) => {
      const data = results[0] as { path: string; entries: FileEntry[]; error?: string } | undefined;
      if (data?.entries) {
        setEntries(data.entries);
        setCurrentPath(data.path);
        setPath(data.path);
        setShowSuggestions(false);
      }
    });
  }, [request]);

  // Fetch suggestions for autocomplete
  const fetchSuggestions = useCallback((inputPath: string) => {
    // Determine parent directory to list
    const lastSlash = inputPath.lastIndexOf('/');
    const parentDir = lastSlash === 0 ? '/' : inputPath.substring(0, lastSlash) || '/';
    const prefix = inputPath.substring(lastSlash + 1).toLowerCase();

    const opts: Record<string, string> = { path: parentDir };
    const currentSu = suRef.current;
    if (currentSu.active && currentSu.password) opts.password = currentSu.password;
    request('file.list', opts).then((results) => {
      const data = results[0] as { path: string; entries: FileEntry[] } | undefined;
      if (data?.entries) {
        const dirs = data.entries
          .filter((e) => e.type === 'directory')
          .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix))
          .map((e) => (parentDir === '/' ? `/${e.name}` : `${parentDir}/${e.name}`))
          .slice(0, 12);
        setSuggestions(dirs);
        setShowSuggestions(dirs.length > 0);
        setSelectedIdx(-1);
      }
    }).catch(() => {
      setSuggestions([]);
      setShowSuggestions(false);
    });
  }, [request]);

  useEffect(() => {
    setEntries([]);
    setPath(homeDir);
    setCurrentPath(homeDir);
    fetchDir(homeDir);
  }, [homeDir, fetchDir]);

  // Reset to home when superuser mode is deactivated
  useEffect(() => {
    if (!su.active) {
      fetchDir(homeDir);
    }
  }, [su.active]);

  // Close suggestions on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        inputRef.current !== e.target
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handlePathChange = (value: string) => {
    setPath(value);
    // Debounce autocomplete requests
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.includes('/')) {
      debounceRef.current = setTimeout(() => fetchSuggestions(value), 150);
    } else {
      setShowSuggestions(false);
    }
  };

  const selectSuggestion = (suggestion: string) => {
    setPath(suggestion);
    setShowSuggestions(false);
    fetchDir(suggestion);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, suggestions.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const idx = selectedIdx >= 0 ? selectedIdx : 0;
        // Tab completes but doesn't navigate
        setPath(suggestions[idx] + '/');
        setShowSuggestions(false);
        // Trigger suggestions for the new path
        setTimeout(() => fetchSuggestions(suggestions[idx] + '/'), 50);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIdx >= 0) {
          selectSuggestion(suggestions[selectedIdx]);
        } else {
          fetchDir(path);
        }
      } else if (e.key === 'Escape') {
        setShowSuggestions(false);
      }
    } else if (e.key === 'Enter') {
      fetchDir(path);
    }
  };

  const navigateTo = (name: string) => {
    const newPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    fetchDir(newPath);
  };

  const navigateUp = () => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    fetchDir(parent);
  };

  return (
    <div>
      <h2>Files</h2>
      <div style={styles.pathBar}>
        <button onClick={navigateUp} style={styles.upBtn}>
          ..
        </button>
        <div style={styles.inputWrapper}>
          <input
            ref={inputRef}
            type="text"
            value={path}
            onChange={(e) => handlePathChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => path.includes('/') && fetchSuggestions(path)}
            style={{ ...styles.pathInput, borderColor: path ? '#7aa2f7' : '#9ece6a' }}
            spellCheck={false}
          />
          {showSuggestions && suggestions.length > 0 && (
            <div ref={suggestionsRef} style={styles.suggestions}>
              {suggestions.map((s, i) => (
                <div
                  key={s}
                  style={{
                    ...styles.suggestionItem,
                    background: i === selectedIdx ? 'var(--accent)' : 'transparent',
                    color: i === selectedIdx ? '#fff' : 'var(--text-primary)',
                  }}
                  onMouseDown={() => selectSuggestion(s)}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  {s}/
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => fetchDir(path)} style={styles.goBtn}>
          Go
        </button>
      </div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Name</th>
            <th style={styles.th}>Type</th>
            <th style={styles.th}>Size</th>
          </tr>
        </thead>
        <tbody>
          {entries
            .sort((a, b) => {
              if (a.type === 'directory' && b.type !== 'directory') return -1;
              if (a.type !== 'directory' && b.type === 'directory') return 1;
              return a.name.localeCompare(b.name);
            })
            .map((entry) => (
              <tr key={entry.name}>
                <td style={styles.td}>
                  {entry.type === 'directory' ? (
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        navigateTo(entry.name);
                      }}
                      style={styles.dirLink}
                    >
                      {entry.name}/
                    </a>
                  ) : (
                    entry.name
                  )}
                </td>
                <td style={styles.td}>{entry.type}</td>
                <td style={styles.td}>{formatSize(entry.size)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const styles: Record<string, React.CSSProperties> = {
  pathBar: {
    display: 'flex',
    gap: '0.5rem',
    margin: '1rem 0',
  },
  upBtn: {
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontWeight: 700,
  },
  inputWrapper: {
    flex: 1,
    position: 'relative' as const,
  },
  pathInput: {
    width: '100%',
    padding: '0.5rem',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    boxSizing: 'border-box' as const,
  },
  suggestions: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderTop: 'none',
    borderRadius: '0 0 4px 4px',
    maxHeight: '240px',
    overflowY: 'auto' as const,
    zIndex: 100,
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  },
  suggestionItem: {
    padding: '0.4rem 0.6rem',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  goBtn: {
    padding: '0.5rem 1rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    textTransform: 'uppercase' as const,
  },
  td: {
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    fontSize: '0.9rem',
  },
  dirLink: {
    color: 'var(--accent)',
    fontWeight: 600,
  },
};
