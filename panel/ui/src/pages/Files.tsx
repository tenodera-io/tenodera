import { useEffect, useState, useRef, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from '../api/SuperuserContext.tsx';
import React from 'react';

interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'unknown';
  size: number;
}

interface ReadResult {
  path?: string;
  content?: string;
  total_lines?: number;
  offset?: number;
  limit?: number;
  binary?: boolean;
  mime?: string;
  error?: string;
}

interface WriteResult { ok?: boolean; error?: string; }

const PAGE_LINES = 200;

interface FilesProps { user: string; }

// ── Modal state ──────────────────────────────────────────────────────────────

type ModalState =
  | { kind: 'view';   path: string; content: string; totalLines: number; offset: number; loading: boolean; error?: string; binary?: boolean; mime?: string }
  | { kind: 'edit';   path: string; draft: string; saving: boolean; error?: string }
  | { kind: 'create'; newPath: string; draft: string; saving: boolean; error?: string }
  | { kind: 'delete'; path: string; name: string; deleting: boolean; error?: string }
  | null;

export function Files({ user }: FilesProps) {
  const { request } = useTransport();
  const su = useSuperuser();
  const homeDir = user ? `/home/${user}` : '/';

  const [currentPath, setCurrentPath] = useState(homeDir);
  const [pathInput, setPathInput]     = useState(homeDir);
  const [entries, setEntries]         = useState<FileEntry[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSugg, setShowSugg]       = useState(false);
  const [selIdx, setSelIdx]           = useState(-1);
  const [modal, setModal]             = useState<ModalState>(null);
  const [navError, setNavError]       = useState<string | undefined>();

  const inputRef      = useRef<HTMLInputElement>(null);
  const suggestRef    = useRef<HTMLDivElement>(null);
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suRef         = useRef(su);
  suRef.current = su;

  // ── Directory listing ────────────────────────────────────────────────────

  const fetchDir = useCallback((dirPath: string) => {
    const opts: Record<string, unknown> = { path: dirPath };
    const cur = suRef.current;
    if (cur.active && cur.password) opts.password = cur.password;
    request('file.list', opts).then((results) => {
      const data = results[0] as { path: string; entries: FileEntry[]; error?: string } | undefined;
      if (data?.entries) {
        setNavError(undefined);
        setEntries(data.entries);
        setCurrentPath(data.path);
        setPathInput(data.path);
        setShowSugg(false);
      } else if (data?.error) {
        setNavError(data.error);
      }
    }).catch((e: unknown) => setNavError(String(e)));
  }, [request]);

  const fetchSuggestions = useCallback((inputPath: string) => {
    const lastSlash = inputPath.lastIndexOf('/');
    const parentDir = lastSlash === 0 ? '/' : inputPath.substring(0, lastSlash) || '/';
    const prefix    = inputPath.substring(lastSlash + 1).toLowerCase();
    const opts: Record<string, unknown> = { path: parentDir };
    const cur = suRef.current;
    if (cur.active && cur.password) opts.password = cur.password;
    request('file.list', opts).then((results) => {
      const data = results[0] as { entries: FileEntry[] } | undefined;
      if (data?.entries) {
        const dirs = data.entries
          .filter((e) => e.type === 'directory')
          .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix))
          .map((e) => (parentDir === '/' ? `/${e.name}` : `${parentDir}/${e.name}`))
          .slice(0, 12);
        setSuggestions(dirs);
        setShowSugg(dirs.length > 0);
        setSelIdx(-1);
      }
    }).catch(() => { setSuggestions([]); setShowSugg(false); });
  }, [request]);

  useEffect(() => {
    setEntries([]);
    setPathInput(homeDir);
    setCurrentPath(homeDir);
    fetchDir(homeDir);
  }, [homeDir, fetchDir]);

  useEffect(() => {
    if (!su.active) fetchDir(homeDir);
  }, [su.active, fetchDir, homeDir]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node) && inputRef.current !== e.target)
        setShowSugg(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const navigateTo = (name: string) => {
    const newPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    fetchDir(newPath);
  };

  const navigateUp = () => {
    if (!su.active && currentPath === homeDir) return;
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    fetchDir(parent);
  };

  const handlePathChange = (value: string) => {
    setPathInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.includes('/')) {
      debounceRef.current = setTimeout(() => fetchSuggestions(value), 150);
    } else {
      setShowSugg(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSugg && suggestions.length > 0) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); setSelIdx(p => Math.min(p + 1, suggestions.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelIdx(p => Math.max(p - 1, 0)); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const idx = selIdx >= 0 ? selIdx : 0;
        setPathInput(suggestions[idx] + '/');
        setShowSugg(false);
        setTimeout(() => fetchSuggestions(suggestions[idx] + '/'), 50);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selIdx >= 0) { fetchDir(suggestions[selIdx]); setShowSugg(false); }
        else fetchDir(pathInput);
      } else if (e.key === 'Escape') setShowSugg(false);
    } else if (e.key === 'Enter') fetchDir(pathInput);
  };

  // ── File open/view ───────────────────────────────────────────────────────

  const openFile = useCallback((filePath: string) => {
    setModal({ kind: 'view', path: filePath, content: '', totalLines: 0, offset: 0, loading: true });

    const cur = suRef.current;
    const opts: Record<string, unknown> = { path: filePath, offset: 0 };
    if (cur.active && cur.password) opts.password = cur.password;

    request('file.read', opts).then((results) => {
      const data = results[0] as ReadResult | undefined;
      if (!data) { setModal(m => m?.kind === 'view' ? { ...m, loading: false, error: 'No response' } : m); return; }
      if (data.error) { setModal(m => m?.kind === 'view' ? { ...m, loading: false, error: data.error } : m); return; }
      if (data.binary) {
        setModal(m => m?.kind === 'view' ? { ...m, loading: false, binary: true, mime: data.mime } : m);
        return;
      }
      setModal(m => m?.kind === 'view' ? {
        ...m, loading: false,
        content: data.content ?? '',
        totalLines: data.total_lines ?? 0,
        offset: 0,
      } : m);
    }).catch((e: unknown) => {
      setModal(m => m?.kind === 'view' ? { ...m, loading: false, error: String(e) } : m);
    });
  }, [request]);

  const changePage = useCallback((newOffset: number) => {
    if (modal?.kind !== 'view') return;
    const { path } = modal;
    setModal(m => m?.kind === 'view' ? { ...m, loading: true, offset: newOffset } : m);

    const cur = suRef.current;
    const opts: Record<string, unknown> = { path, offset: newOffset };
    if (cur.active && cur.password) opts.password = cur.password;

    request('file.read', opts).then((results) => {
      const data = results[0] as ReadResult | undefined;
      if (!data || data.error) {
        setModal(m => m?.kind === 'view' ? { ...m, loading: false, error: data?.error ?? 'error' } : m);
        return;
      }
      setModal(m => m?.kind === 'view' ? {
        ...m, loading: false,
        content: data.content ?? '',
        totalLines: data.total_lines ?? 0,
        offset: newOffset,
      } : m);
    });
  }, [modal, request]);

  // ── Edit ─────────────────────────────────────────────────────────────────

  const startEdit = () => {
    if (modal?.kind !== 'view') return;
    setModal({ kind: 'edit', path: modal.path, draft: modal.content, saving: false });
  };

  const saveEdit = () => {
    if (modal?.kind !== 'edit') return;
    const { path, draft } = modal;
    const cur = suRef.current;
    setModal(m => m?.kind === 'edit' ? { ...m, saving: true, error: undefined } : m);

    const opts: Record<string, unknown> = { path, content: draft };
    if (cur.active && cur.password) opts.password = cur.password;
    request('file.write', opts).then((results) => {
      const data = results[0] as WriteResult | undefined;
      if (data?.error) {
        setModal(m => m?.kind === 'edit' ? { ...m, saving: false, error: data.error } : m);
      } else {
        // Re-open viewer with fresh content
        openFile(path);
      }
    }).catch((e: unknown) => {
      setModal(m => m?.kind === 'edit' ? { ...m, saving: false, error: String(e) } : m);
    });
  };

  // ── Create ───────────────────────────────────────────────────────────────

  const openCreate = () => {
    const base = currentPath.endsWith('/') ? currentPath : currentPath + '/';
    setModal({ kind: 'create', newPath: base, draft: '', saving: false });
  };

  const saveCreate = () => {
    if (modal?.kind !== 'create') return;
    const { newPath, draft } = modal;
    const cur = suRef.current;
    setModal(m => m?.kind === 'create' ? { ...m, saving: true, error: undefined } : m);

    const opts: Record<string, unknown> = { path: newPath, content: draft };
    if (cur.active && cur.password) opts.password = cur.password;
    request('file.write', opts).then((results) => {
      const data = results[0] as WriteResult | undefined;
      if (data?.error) {
        setModal(m => m?.kind === 'create' ? { ...m, saving: false, error: data.error } : m);
      } else {
        setModal(null);
        fetchDir(currentPath);
      }
    }).catch((e: unknown) => {
      setModal(m => m?.kind === 'create' ? { ...m, saving: false, error: String(e) } : m);
    });
  };

  // ── Delete ───────────────────────────────────────────────────────────────

  const openDelete = (entry: FileEntry) => {
    const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    setModal({ kind: 'delete', path: filePath, name: entry.name, deleting: false });
  };

  const confirmDelete = () => {
    if (modal?.kind !== 'delete') return;
    const { path } = modal;
    const cur = suRef.current;
    setModal(m => m?.kind === 'delete' ? { ...m, deleting: true, error: undefined } : m);

    const opts: Record<string, unknown> = { path };
    if (cur.active && cur.password) opts.password = cur.password;
    request('file.delete', opts).then((results) => {
      const data = results[0] as WriteResult | undefined;
      if (data?.error) {
        setModal(m => m?.kind === 'delete' ? { ...m, deleting: false, error: data.error } : m);
      } else {
        setModal(null);
        fetchDir(currentPath);
      }
    }).catch((e: unknown) => {
      setModal(m => m?.kind === 'delete' ? { ...m, deleting: false, error: String(e) } : m);
    });
  };

  // ── Sorted entries ───────────────────────────────────────────────────────

  const sorted = [...entries].sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div>
      <h2 style={{ marginTop: 0, marginBottom: '1rem' }}>Files</h2>

      {/* Path bar */}
      <div style={S.pathBar}>
        <button
          onClick={navigateUp}
          style={{ ...S.upBtn, opacity: (!su.active && currentPath === homeDir) ? 0.35 : 1 }}
          disabled={!su.active && currentPath === homeDir}
          title={!su.active ? 'Limited access: home directory only' : undefined}
        >↑</button>
        <div style={S.inputWrap}>
          <input
            ref={inputRef}
            type="text"
            value={pathInput}
            readOnly={!su.active}
            onChange={(e) => { if (su.active) handlePathChange(e.target.value); }}
            onKeyDown={(e) => { if (su.active) handleKeyDown(e); }}
            onFocus={() => { if (su.active && pathInput.includes('/')) fetchSuggestions(pathInput); }}
            style={{ ...S.pathInput, cursor: su.active ? undefined : 'default', opacity: su.active ? 1 : 0.7 }}
            spellCheck={false}
          />
          {su.active && showSugg && suggestions.length > 0 && (
            <div ref={suggestRef} style={S.suggestions}>
              {suggestions.map((s, i) => (
                <div
                  key={s}
                  style={{ ...S.suggItem, background: i === selIdx ? 'var(--c-blue)' : 'transparent', color: i === selIdx ? '#fff' : 'var(--text-1)' }}
                  onMouseDown={() => { fetchDir(s); setShowSugg(false); }}
                  onMouseEnter={() => setSelIdx(i)}
                >
                  {s}/
                </div>
              ))}
            </div>
          )}
        </div>
        {su.active
          ? <button onClick={() => fetchDir(pathInput)} style={S.goBtn}>Go</button>
          : <span style={S.limitedBadge} title="Activate Administrative access to browse the full filesystem">Limited</span>
        }
        <button onClick={openCreate} style={S.newBtn}>+ New File</button>
      </div>
      {navError && (
        <div style={{ ...S.errorBox, marginBottom: '0.75rem' }}>{navError}</div>
      )}

      {/* File table */}
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Name</th>
            <th style={S.th}>Type</th>
            <th style={S.th}>Size</th>
            <th style={{ ...S.th, width: 120 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => (
            <tr key={entry.name} style={S.row}>
              <td style={S.td}>
                {entry.type === 'directory' ? (
                  <a href="#" onClick={(e) => { e.preventDefault(); navigateTo(entry.name); }} style={S.dirLink}>
                    {entry.name}/
                  </a>
                ) : (
                  <span
                    style={S.fileLink}
                    onClick={() => {
                      const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
                      openFile(filePath);
                    }}
                  >
                    {entry.name}
                  </span>
                )}
              </td>
              <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{entry.type}</td>
              <td style={{ ...S.td, color: 'var(--text-2)', fontSize: '0.8rem' }}>{formatSize(entry.size)}</td>
              <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                {entry.type !== 'directory' && (
                  <button
                    style={S.actionBtn}
                    onClick={() => {
                      const p = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
                      openFile(p);
                    }}
                  >View</button>
                )}
                <button
                  style={{ ...S.actionBtn, ...S.delBtn, marginLeft: 4 }}
                  onClick={() => openDelete(entry)}
                >Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── Modals ──────────────────────────────────────────────────────── */}
      {modal && (
        <div style={S.overlay} onClick={() => setModal(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>

            {/* ── File Viewer ── */}
            {modal.kind === 'view' && (
              <ViewerModal
                modal={modal}
                onClose={() => setModal(null)}
                onEdit={startEdit}
                onChangePage={changePage}
              />
            )}

            {/* ── File Editor (edit existing) ── */}
            {modal.kind === 'edit' && (
              <EditorModal
                title={`Edit: ${modal.path}`}
                draft={modal.draft}
                saving={modal.saving}
                error={modal.error}
                onDraftChange={(v) => setModal(m => m?.kind === 'edit' ? { ...m, draft: v } : m)}
                onSave={saveEdit}
                onCancel={() => openFile(modal.path)}
              />
            )}

            {/* ── File Creator (new file) ── */}
            {modal.kind === 'create' && (
              <CreateModal
                modal={modal}
                onPathChange={(v) => setModal(m => m?.kind === 'create' ? { ...m, newPath: v } : m)}
                onDraftChange={(v) => setModal(m => m?.kind === 'create' ? { ...m, draft: v } : m)}
                onSave={saveCreate}
                onCancel={() => setModal(null)}
              />
            )}

            {/* ── Delete confirm ── */}
            {modal.kind === 'delete' && (
              <DeleteModal
                modal={modal}
                onConfirm={confirmDelete}
                onCancel={() => setModal(null)}
              />
            )}

          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ViewerModal({ modal, onClose, onEdit, onChangePage }: {
  modal: Extract<ModalState, { kind: 'view' }>;
  onClose: () => void;
  onEdit: () => void;
  onChangePage: (offset: number) => void;
}) {
  const { path, content, totalLines, offset, loading, error, binary, mime } = modal;
  const lines = content ? content.split('\n') : [];
  // If last element is empty string (trailing newline), drop it for display
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const totalPages = Math.max(1, Math.ceil(totalLines / PAGE_LINES));
  const currentPage = Math.floor(offset / PAGE_LINES) + 1;
  const lineFrom = offset + 1;
  const lineTo   = Math.min(offset + PAGE_LINES, totalLines || (offset + lines.length));

  const name = path.split('/').pop() ?? path;

  return (
    <>
      <div style={S.modalHeader}>
        <span style={S.modalTitle} title={path}>{name}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {!binary && !error && !loading && (
            <button style={S.editBtn} onClick={onEdit}>Edit</button>
          )}
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
      </div>

      <div style={S.modalBody}>
        {loading && <div style={S.center}>Loading…</div>}
        {!loading && error && <div style={S.errorBox}>{error}</div>}
        {!loading && binary && (
          <div style={S.center}>
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>🔒</div>
            <div>Binary file — cannot display</div>
            {mime && <div style={{ fontSize: '0.8rem', color: 'var(--text-2)', marginTop: 4 }}>{mime}</div>}
          </div>
        )}
        {!loading && !error && !binary && (
          <pre style={S.pre}>
            {lines.map((line, i) => (
              <div key={i} style={S.codeLine}>
                <span style={S.lineNum}>{offset + i + 1}</span>
                <span style={S.lineText}>{line}</span>
              </div>
            ))}
            {lines.length === 0 && <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>Empty file</span>}
          </pre>
        )}
      </div>

      {!loading && !binary && !error && totalLines > PAGE_LINES && (
        <div style={S.modalFooter}>
          <span style={{ color: 'var(--text-2)', fontSize: '0.8rem' }}>
            Lines {lineFrom}–{lineTo} of {totalLines} &nbsp;|&nbsp; Page {currentPage} of {totalPages}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...S.pageBtn, opacity: offset === 0 ? 0.4 : 1 }}
              disabled={offset === 0}
              onClick={() => onChangePage(Math.max(0, offset - PAGE_LINES))}
            >← Prev</button>
            <button
              style={{ ...S.pageBtn, opacity: offset + PAGE_LINES >= totalLines ? 0.4 : 1 }}
              disabled={offset + PAGE_LINES >= totalLines}
              onClick={() => onChangePage(offset + PAGE_LINES)}
            >Next →</button>
          </div>
        </div>
      )}
      {!loading && !binary && !error && totalLines <= PAGE_LINES && totalLines > 0 && (
        <div style={S.modalFooter}>
          <span style={{ color: 'var(--text-2)', fontSize: '0.8rem' }}>{totalLines} line{totalLines !== 1 ? 's' : ''}</span>
        </div>
      )}
    </>
  );
}

function EditorModal({ title, draft, saving, error, onDraftChange, onSave, onCancel }: {
  title: string; draft: string; saving: boolean; error?: string;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div style={S.modalHeader}>
        <span style={{ ...S.modalTitle, fontSize: '0.9rem' }} title={title}>{title}</span>
        <button style={S.closeBtn} onClick={onCancel}>✕</button>
      </div>
      <div style={{ ...S.modalBody, padding: 0 }}>
        <textarea
          style={S.textarea}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      </div>
      {error && <div style={S.errorBox}>{error}</div>}
      <div style={S.modalFooter}>
        <button style={S.cancelBtn} onClick={onCancel}>Cancel</button>
        <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

function CreateModal({ modal, onPathChange, onDraftChange, onSave, onCancel }: {
  modal: Extract<ModalState, { kind: 'create' }>;
  onPathChange: (v: string) => void;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div style={S.modalHeader}>
        <span style={S.modalTitle}>New File</span>
        <button style={S.closeBtn} onClick={onCancel}>✕</button>
      </div>
      <div style={{ ...S.modalBody, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label style={{ fontSize: '0.8rem', color: 'var(--text-2)' }}>Path</label>
        <input
          type="text"
          value={modal.newPath}
          onChange={(e) => onPathChange(e.target.value)}
          style={S.pathInput}
          spellCheck={false}
          autoFocus
        />
        <label style={{ fontSize: '0.8rem', color: 'var(--text-2)', marginTop: 4 }}>Content</label>
        <textarea
          style={{ ...S.textarea, minHeight: 260 }}
          value={modal.draft}
          onChange={(e) => onDraftChange(e.target.value)}
          spellCheck={false}
        />
      </div>
      {modal.error && <div style={S.errorBox}>{modal.error}</div>}
      <div style={S.modalFooter}>
        <button style={S.cancelBtn} onClick={onCancel}>Cancel</button>
        <button style={{ ...S.saveBtn, opacity: modal.saving ? 0.6 : 1 }} onClick={onSave} disabled={modal.saving}>
          {modal.saving ? 'Creating…' : 'Create'}
        </button>
      </div>
    </>
  );
}

function DeleteModal({ modal, onConfirm, onCancel }: {
  modal: Extract<ModalState, { kind: 'delete' }>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div style={S.modalHeader}>
        <span style={S.modalTitle}>Delete file</span>
        <button style={S.closeBtn} onClick={onCancel}>✕</button>
      </div>
      <div style={{ ...S.modalBody, textAlign: 'center', padding: '2rem 1rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>🗑️</div>
        <div style={{ marginBottom: '0.5rem' }}>
          Delete <strong style={{ fontFamily: 'monospace' }}>{modal.name}</strong>?
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-2)' }}>{modal.path}</div>
        {modal.error && <div style={{ ...S.errorBox, marginTop: 12 }}>{modal.error}</div>}
      </div>
      <div style={S.modalFooter}>
        <button style={S.cancelBtn} onClick={onCancel}>Cancel</button>
        <button
          style={{ ...S.saveBtn, background: 'var(--c-red)', opacity: modal.deleting ? 0.6 : 1 }}
          onClick={onConfirm}
          disabled={modal.deleting}
        >
          {modal.deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576)    return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes > 1024)       return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  // Path bar
  pathBar:    { display: 'flex', gap: 8, marginBottom: '1rem', alignItems: 'center' },
  upBtn:      { padding: '0.45rem 0.7rem', borderRadius: 4, border: '1px solid var(--border-1)', background: 'var(--bg-surface)', color: 'var(--text-1)', cursor: 'pointer' },
  inputWrap:  { flex: 1, position: 'relative' },
  pathInput:  { width: '100%', padding: '0.45rem 0.6rem', borderRadius: 4, border: '1px solid var(--c-blue)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontFamily: 'monospace', boxSizing: 'border-box', fontSize: '0.9rem' },
  goBtn:      { padding: '0.45rem 0.9rem', borderRadius: 4, border: 'none', background: 'var(--c-blue)', color: '#fff', cursor: 'pointer' },
  newBtn:       { padding: '0.45rem 0.9rem', borderRadius: 4, border: 'none', background: 'var(--c-green)', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
  limitedBadge: { padding: '0.3rem 0.7rem', borderRadius: 4, border: '1px solid var(--border-1)', background: 'transparent', color: 'var(--text-3)', fontSize: '0.78rem', whiteSpace: 'nowrap' },
  suggestions: { position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderTop: 'none', borderRadius: '0 0 4px 4px', maxHeight: 240, overflowY: 'auto', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,.3)' },
  suggItem:   { padding: '0.4rem 0.6rem', fontFamily: 'monospace', fontSize: '0.85rem', cursor: 'pointer' },

  // Table
  table:    { width: '100%', borderCollapse: 'collapse' },
  th:       { textAlign: 'left', padding: '0.5rem 0.6rem', borderBottom: '1px solid var(--border-1)', color: 'var(--text-2)', fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: 600 },
  row:      { transition: 'background 0.1s' },
  td:       { padding: '0.45rem 0.6rem', borderBottom: '1px solid var(--border-1)', fontSize: '0.9rem' },
  dirLink:  { color: 'var(--c-blue)', fontWeight: 600, textDecoration: 'none' },
  fileLink: { color: 'var(--text-1)', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 },
  actionBtn: { padding: '0.2rem 0.55rem', borderRadius: 4, border: '1px solid var(--border-1)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.78rem' },
  delBtn:   { borderColor: 'var(--c-red)', color: 'var(--c-red)' },

  // Modal overlay + box
  overlay:  { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600 },
  modal:    { background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 10, width: '90%', maxWidth: 820, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 16px 48px rgba(0,0,0,.5)' },

  // Modal sections
  modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border-1)', flexShrink: 0 },
  modalTitle:  { fontFamily: 'monospace', fontSize: '0.95rem', color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' },
  modalBody:   { flex: 1, overflow: 'auto', padding: '0.5rem 0' },
  modalFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 1rem', borderTop: '1px solid var(--border-1)', flexShrink: 0 },

  // Viewer
  pre:      { margin: 0, padding: 0, fontFamily: 'monospace', fontSize: '0.82rem', lineHeight: 1.55, background: 'none' },
  codeLine: { display: 'flex', minHeight: '1.55em' },
  lineNum:  { display: 'inline-block', minWidth: 44, paddingRight: 12, textAlign: 'right', color: 'var(--text-3)', userSelect: 'none', flexShrink: 0 },
  lineText: { flex: 1, whiteSpace: 'pre', overflowX: 'auto', color: 'var(--text-1)' },

  // Buttons
  closeBtn:  { background: 'transparent', border: 'none', color: 'var(--text-2)', fontSize: '1.1rem', cursor: 'pointer', padding: '0.2rem 0.4rem', borderRadius: 4 },
  editBtn:   { padding: '0.3rem 0.8rem', borderRadius: 4, border: '1px solid var(--c-blue)', background: 'transparent', color: 'var(--c-blue)', cursor: 'pointer', fontSize: '0.85rem' },
  pageBtn:   { padding: '0.3rem 0.8rem', borderRadius: 4, border: '1px solid var(--border-1)', background: 'var(--bg-surface)', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.85rem' },
  saveBtn:   { padding: '0.4rem 1rem', borderRadius: 4, border: 'none', background: 'var(--c-blue)', color: '#fff', cursor: 'pointer', fontSize: '0.9rem' },
  cancelBtn: { padding: '0.4rem 1rem', borderRadius: 4, border: '1px solid var(--border-1)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.9rem' },

  // Editor
  textarea:  { width: '100%', minHeight: 360, resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem', padding: '0.6rem', background: 'var(--bg-surface)', color: 'var(--text-1)', border: 'none', outline: 'none', lineHeight: 1.55, boxSizing: 'border-box' },

  // Misc
  errorBox: { margin: '0 1rem', padding: '0.5rem 0.75rem', borderRadius: 4, background: 'rgba(var(--c-red-rgb,220,38,38),.15)', color: 'var(--c-red)', fontSize: '0.85rem' },
  center:   { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 120, color: 'var(--text-2)', fontSize: '0.9rem' },
};
