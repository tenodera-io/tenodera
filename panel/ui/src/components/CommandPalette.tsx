// Ctrl/Cmd+K command palette. Navigation-only for now: jump to any page or
// sub-tab. Entries come from the shared nav (src/nav.ts), so they stay in sync
// with the sidebar. Admin pages appear only when superuser mode is active.
//
// Rows are grouped visually per page (a page and its sub-tabs), separated by a
// thin divider. The grouping is derived dynamically from each command's `path`,
// so nothing here needs touching when nav.ts changes.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './Icons.tsx';
import { buildCommands, type Command } from '../nav.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  suActive: boolean;
}

// Rank a command against the (lowercased, trimmed) query. -1 = no match.
function score(label: string, q: string): number {
  const idx = label.indexOf(q);
  if (idx === -1) return -1;
  if (label.startsWith(q)) return 100 - idx;
  // start of a word (after a space, arrow, or slash)
  if (label.split(/[\s→/+]+/).some((w) => w.startsWith(q))) return 60 - idx;
  return 30 - idx;
}

export function CommandPalette({ open, onClose, suActive }: Props) {
  const navigate = useNavigate();
  const commands = useMemo(() => buildCommands(suActive), [suActive]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands
      .map((c) => ({ c, s: score(c.label.toLowerCase(), q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, query]);

  // Reset + focus each time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (cmd?: Command) => {
    if (!cmd) return;
    navigate(cmd.tab ? `${cmd.path}?tab=${cmd.tab}` : cmd.path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div
        style={S.panel}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div style={S.inputRow}>
          <span style={{ color: 'var(--text-2)', display: 'inline-flex' }}>
            <Icon name="search" size={18} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a page or tab…"
            style={S.input}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd style={S.kbd}>Esc</kbd>
        </div>

        <div ref={listRef} style={S.list}>
          {results.length === 0 ? (
            <div style={S.empty}>No matches</div>
          ) : (
            results.map((cmd, i) => {
              // Thin divider when this row starts a new page group.
              const newGroup = i > 0 && cmd.path !== results[i - 1].path;
              return (
                <div key={cmd.id}>
                  {newGroup && <div style={S.divider} />}
                  <div
                    data-idx={i}
                    onMouseMove={() => active !== i && setActive(i)}
                    onClick={() => choose(cmd)}
                    style={{ ...S.row, ...(i === active ? S.rowActive : null) }}
                  >
                    <span style={S.rowIcon}><Icon name={cmd.icon} size={16} /></span>
                    <span style={S.rowLabel}>{cmd.label}</span>
                    <span style={S.rowSection}>{cmd.section}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 600,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    paddingTop: '14vh',
  },
  panel: {
    width: 'min(560px, 92vw)', maxHeight: '62vh',
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg-app)',
    border: '1px solid var(--border-1)', borderRadius: 12,
    boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
    overflow: 'hidden',
  },
  inputRow: {
    display: 'flex', alignItems: 'center', gap: '0.6rem',
    padding: '0.85rem 1rem',
    borderBottom: '1px solid var(--border-1)',
  },
  input: {
    flex: 1, background: 'transparent', border: 'none', outline: 'none',
    color: 'var(--text-1)', fontSize: '1rem',
  },
  kbd: {
    fontSize: '0.68rem', color: 'var(--text-2)',
    border: '1px solid var(--border-1)', borderRadius: 5,
    padding: '0.1rem 0.4rem', background: 'var(--bg-surface)',
  },
  list: { overflowY: 'auto', padding: '0.4rem' },
  empty: { padding: '1.5rem', textAlign: 'center', color: 'var(--text-2)', fontSize: '0.85rem' },
  divider: { height: 1, background: 'var(--border-1)', margin: '0.3rem 0.5rem' },
  row: {
    display: 'flex', alignItems: 'center', gap: '0.6rem',
    padding: '0.5rem 0.65rem', borderRadius: 7, cursor: 'pointer',
    color: 'var(--text-1)',
  },
  rowActive: { background: 'color-mix(in srgb, var(--c-blue) 18%, transparent)' },
  rowIcon: { display: 'inline-flex', color: 'var(--text-2)', flexShrink: 0 },
  rowLabel: { flex: 1, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSection: { fontSize: '0.7rem', color: 'var(--text-2)', flexShrink: 0 },
};

import React from 'react';
