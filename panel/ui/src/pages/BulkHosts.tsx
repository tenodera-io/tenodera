import { useState, useRef, useCallback, useEffect } from 'react';
import { openChannel, request, type Message } from '../api/transport.ts';

/* ── Types ─────────────────────────────────────────────── */

type Tab = 'quick' | 'advanced';

interface AdvancedRow {
  address: string;
  user: string;
  port: string;
}

type HostStep = 'pending' | 'keyscan' | 'adding' | 'resolving' | 'renaming' | 'done' | 'error';

interface HostProgress {
  address: string;
  user: string;
  port: number;
  step: HostStep;
  detail: string;
  hostname?: string;
  hostId?: string;
}

type Channel = ReturnType<typeof openChannel>;

/* ── Helpers ───────────────────────────────────────────── */

function parseAddresses(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/* ── Component ─────────────────────────────────────────── */

export function BulkHosts() {
  const [tab, setTab] = useState<Tab>('quick');

  /* Quick Add state */
  const [quickText, setQuickText] = useState('');

  /* Advanced Add state */
  const [rows, setRows] = useState<AdvancedRow[]>([{ address: '', user: '', port: '22' }]);

  /* Processing state */
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<HostProgress[]>([]);
  const queueRef = useRef<HostProgress[]>([]);
  const activeIdxRef = useRef(0);
  const chRef = useRef<Channel | null>(null);
  const cancelledRef = useRef(false);

  /* Cleanup channel on unmount */
  useEffect(() => {
    return () => {
      if (chRef.current) { chRef.current.close(); chRef.current = null; }
    };
  }, []);

  /* ── update a single progress entry ── */
  const updateProgress = useCallback((idx: number, patch: Partial<HostProgress>) => {
    setProgress((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
    // Also update the queue ref for the processing loop
    if (queueRef.current[idx]) {
      Object.assign(queueRef.current[idx], patch);
    }
  }, []);

  /* ── process a single host (sequential, promise-based) ── */
  const processHost = useCallback(async (idx: number, entry: HostProgress) => {
    if (cancelledRef.current) return;

    /* Step 1: keyscan */
    updateProgress(idx, { step: 'keyscan', detail: 'Scanning host key...' });

    let hostKey: string;
    try {
      hostKey = await new Promise<string>((resolve, reject) => {
        const ch = openChannel('hosts.manage');
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) { resolved = true; ch.close(); reject(new Error('Keyscan timeout')); }
        }, 15_000);

        ch.onMessage((msg: Message) => {
          if (resolved) return;
          if (msg.type === 'data' && 'data' in msg) {
            const d = msg.data as Record<string, unknown>;
            if (d.action === 'keyscan') {
              resolved = true;
              clearTimeout(timer);
              ch.close();
              if (d.ok) {
                resolve((d.host_key as string) || '');
              } else {
                reject(new Error((d.error as string) || 'Keyscan failed'));
              }
            }
          }
          if (msg.type === 'close') {
            if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error('Channel closed')); }
          }
        });

        ch.send({ action: 'keyscan', address: entry.address, ssh_port: entry.port });
      });
    } catch (err) {
      updateProgress(idx, { step: 'error', detail: err instanceof Error ? err.message : 'Keyscan failed' });
      return;
    }

    if (cancelledRef.current) return;

    /* Step 2: add host (name = IP address initially) */
    updateProgress(idx, { step: 'adding', detail: 'Adding host...' });

    let newHostId: string;
    try {
      newHostId = await new Promise<string>((resolve, reject) => {
        const ch = openChannel('hosts.manage');
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) { resolved = true; ch.close(); reject(new Error('Add timeout')); }
        }, 10_000);

        ch.onMessage((msg: Message) => {
          if (resolved) return;
          if (msg.type === 'data' && 'data' in msg) {
            const d = msg.data as Record<string, unknown>;
            if (d.action === 'add') {
              resolved = true;
              clearTimeout(timer);
              ch.close();
              if (d.ok) {
                resolve((d.id as string) || '');
              } else {
                reject(new Error((d.error as string) || 'Add failed'));
              }
            }
          }
          if (msg.type === 'close') {
            if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error('Channel closed')); }
          }
        });

        ch.send({
          action: 'add',
          name: entry.address, // temporary name = IP
          address: entry.address,
          user: entry.user,
          ssh_port: entry.port,
          host_key: hostKey,
        });
      });
    } catch (err) {
      updateProgress(idx, { step: 'error', detail: err instanceof Error ? err.message : 'Add failed' });
      return;
    }

    if (cancelledRef.current) return;

    updateProgress(idx, { hostId: newHostId });

    /* Step 3: resolve real hostname via system.info */
    updateProgress(idx, { step: 'resolving', detail: 'Connecting to get hostname...' });

    let realHostname = entry.address; // fallback
    try {
      const results = await request('system.info', { host: newHostId });
      const info = results[0] as { hostname?: string } | undefined;
      if (info?.hostname) {
        realHostname = info.hostname;
      }
    } catch {
      // If system.info fails, keep IP as name — not a fatal error
      updateProgress(idx, { step: 'done', detail: `Added as ${entry.address} (hostname lookup failed)`, hostname: entry.address });
      return;
    }

    if (cancelledRef.current) return;

    /* Step 4: rename host to real hostname */
    updateProgress(idx, { step: 'renaming', detail: `Renaming to ${realHostname}...` });

    try {
      await new Promise<void>((resolve, reject) => {
        const ch = openChannel('hosts.manage');
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) { resolved = true; ch.close(); reject(new Error('Edit timeout')); }
        }, 10_000);

        ch.onMessage((msg: Message) => {
          if (resolved) return;
          if (msg.type === 'data' && 'data' in msg) {
            const d = msg.data as Record<string, unknown>;
            if (d.action === 'edit') {
              resolved = true;
              clearTimeout(timer);
              ch.close();
              if (d.ok) {
                resolve();
              } else {
                reject(new Error((d.error as string) || 'Rename failed'));
              }
            }
          }
          if (msg.type === 'close') {
            if (!resolved) { resolved = true; clearTimeout(timer); reject(new Error('Channel closed')); }
          }
        });

        ch.send({
          action: 'edit',
          id: newHostId,
          name: realHostname,
          address: entry.address,
          user: entry.user,
          ssh_port: entry.port,
          host_key: hostKey,
        });
      });
    } catch {
      // Rename failed but host was added — partial success
      updateProgress(idx, { step: 'done', detail: `Added as ${entry.address} (rename failed)`, hostname: entry.address });
      return;
    }

    updateProgress(idx, { step: 'done', detail: `Done (${realHostname})`, hostname: realHostname });
  }, [updateProgress]);

  /* ── start processing all hosts sequentially ── */
  const startProcessing = useCallback(async (entries: HostProgress[]) => {
    setProcessing(true);
    cancelledRef.current = false;
    queueRef.current = entries;
    activeIdxRef.current = 0;
    setProgress([...entries]);

    for (let i = 0; i < entries.length; i++) {
      if (cancelledRef.current) break;
      activeIdxRef.current = i;
      await processHost(i, entries[i]);
    }

    setProcessing(false);
  }, [processHost]);

  /* ── Quick Add submit ── */
  const handleQuickSubmit = () => {
    const addrs = parseAddresses(quickText);
    if (addrs.length === 0) return;

    const entries: HostProgress[] = addrs.map((addr) => ({
      address: addr,
      user: '',
      port: 22,
      step: 'pending' as HostStep,
      detail: 'Waiting...',
    }));

    startProcessing(entries);
  };

  /* ── Advanced Add submit ── */
  const handleAdvancedSubmit = () => {
    const valid = rows.filter((r) => r.address.trim());
    if (valid.length === 0) return;

    const entries: HostProgress[] = valid.map((r) => ({
      address: r.address.trim(),
      user: r.user.trim(),
      port: parseInt(r.port, 10) || 22,
      step: 'pending' as HostStep,
      detail: 'Waiting...',
    }));

    startProcessing(entries);
  };

  /* ── Cancel ── */
  const handleCancel = () => {
    cancelledRef.current = true;
  };

  /* ── Reset to add more ── */
  const handleReset = () => {
    setProgress([]);
    setQuickText('');
    setRows([{ address: '', user: '', port: '22' }]);
  };

  /* ── Advanced row helpers ── */
  const updateRow = (idx: number, field: keyof AdvancedRow, value: string) => {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const addRow = () => {
    setRows((prev) => [...prev, { address: '', user: '', port: '22' }]);
  };

  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  /* ── Progress summary ── */
  const doneCount = progress.filter((p) => p.step === 'done').length;
  const errorCount = progress.filter((p) => p.step === 'error').length;
  const allDone = progress.length > 0 && !processing;

  /* ── Step badge ── */
  function stepBadge(step: HostStep): { text: string; color: string; bg: string } {
    switch (step) {
      case 'pending': return { text: 'Waiting', color: '#565f89', bg: '#565f8922' };
      case 'keyscan': return { text: 'Key scan', color: '#7aa2f7', bg: '#7aa2f722' };
      case 'adding': return { text: 'Adding', color: '#e0af68', bg: '#e0af6822' };
      case 'resolving': return { text: 'Resolving', color: '#bb9af7', bg: '#bb9af722' };
      case 'renaming': return { text: 'Renaming', color: '#7dcfff', bg: '#7dcfff22' };
      case 'done': return { text: 'Done', color: '#9ece6a', bg: '#9ece6a22' };
      case 'error': return { text: 'Error', color: '#f7768e', bg: '#f7768e22' };
    }
  }

  /* ── Render ── */
  return (
    <div style={S.page}>
      <h2 style={S.pageTitle}>Manage Hosts</h2>
      <p style={S.pageDesc}>
        Bulk add remote hosts. Each host is automatically key-scanned, added, and renamed
        to its real hostname via SSH.
      </p>

      {/* Tab selector */}
      {!processing && progress.length === 0 && (
        <>
          <div style={S.tabs}>
            <button
              style={{ ...S.tab, ...(tab === 'quick' ? S.tabActive : {}) }}
              onClick={() => setTab('quick')}
            >
              Quick Add
            </button>
            <button
              style={{ ...S.tab, ...(tab === 'advanced' ? S.tabActive : {}) }}
              onClick={() => setTab('advanced')}
            >
              Advanced Add
            </button>
          </div>

          {/* Quick Add tab */}
          {tab === 'quick' && (
            <div style={S.section}>
              <label style={S.label}>
                Paste IP addresses (separated by commas, spaces, or newlines)
              </label>
              <textarea
                style={{
                  ...S.textarea,
                  borderColor: quickText.trim() ? '#7aa2f7' : '#9ece6a',
                }}
                rows={6}
                placeholder={'192.168.56.11\n192.168.56.20\n10.0.0.5'}
                value={quickText}
                onChange={(e) => setQuickText(e.target.value)}
              />
              <div style={S.info}>
                Port 22, SSH user = your login. Host name auto-detected.
              </div>
              <div style={S.actions}>
                <button
                  style={{
                    ...S.submitBtn,
                    opacity: !quickText.trim() ? 0.5 : 1,
                  }}
                  disabled={!quickText.trim()}
                  onClick={handleQuickSubmit}
                >
                  Add Hosts ({parseAddresses(quickText).length || 0})
                </button>
              </div>
            </div>
          )}

          {/* Advanced Add tab */}
          {tab === 'advanced' && (
            <div style={S.section}>
              <div style={S.tableHeader}>
                <span style={{ ...S.thCell, flex: 3 }}>Address</span>
                <span style={{ ...S.thCell, flex: 2 }}>SSH User</span>
                <span style={{ ...S.thCell, flex: 1 }}>Port</span>
                <span style={{ ...S.thCell, width: 32 }} />
              </div>
              {rows.map((row, i) => (
                <div key={i} style={S.tableRow}>
                  <input
                    style={{
                      ...S.rowInput,
                      flex: 3,
                      borderColor: row.address.trim() ? '#7aa2f7' : '#9ece6a',
                    }}
                    placeholder="192.168.56.11"
                    value={row.address}
                    onChange={(e) => updateRow(i, 'address', e.target.value)}
                  />
                  <input
                    style={{
                      ...S.rowInput,
                      flex: 2,
                      borderColor: row.user.trim() ? '#7aa2f7' : '#9ece6a',
                    }}
                    placeholder="(login user)"
                    value={row.user}
                    onChange={(e) => updateRow(i, 'user', e.target.value)}
                  />
                  <input
                    style={{
                      ...S.rowInput,
                      flex: 1,
                      borderColor: row.port && row.port !== '22' ? '#7aa2f7' : '#9ece6a',
                    }}
                    placeholder="22"
                    value={row.port}
                    onChange={(e) => updateRow(i, 'port', e.target.value)}
                  />
                  <button
                    style={S.rowDeleteBtn}
                    onClick={() => removeRow(i)}
                    title="Remove row"
                    disabled={rows.length <= 1}
                  >
                    &#x2715;
                  </button>
                </div>
              ))}
              <button style={S.addRowBtn} onClick={addRow}>
                + Add Row
              </button>
              <div style={S.actions}>
                <button
                  style={{
                    ...S.submitBtn,
                    opacity: !rows.some((r) => r.address.trim()) ? 0.5 : 1,
                  }}
                  disabled={!rows.some((r) => r.address.trim())}
                  onClick={handleAdvancedSubmit}
                >
                  Add Hosts ({rows.filter((r) => r.address.trim()).length})
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Progress view ── */}
      {(processing || progress.length > 0) && (
        <div style={S.section}>
          {/* Summary bar */}
          <div style={S.summary}>
            <span>
              {processing ? 'Processing...' : 'Complete'}{' '}
              <span style={{ color: '#9ece6a' }}>{doneCount} added</span>
              {errorCount > 0 && (
                <span style={{ color: '#f7768e' }}>, {errorCount} failed</span>
              )}
              <span style={{ color: 'var(--text-secondary)' }}> / {progress.length} total</span>
            </span>
            {processing && (
              <button style={S.cancelBtn} onClick={handleCancel}>
                Cancel
              </button>
            )}
            {allDone && (
              <button style={S.submitBtn} onClick={handleReset}>
                Add More
              </button>
            )}
          </div>

          {/* Per-host progress */}
          <div style={S.progressList}>
            {progress.map((p, i) => {
              const badge = stepBadge(p.step);
              return (
                <div key={i} style={S.progressItem}>
                  <span style={S.progressAddr}>{p.address}</span>
                  <span
                    style={{
                      ...S.progressBadge,
                      color: badge.color,
                      background: badge.bg,
                      borderColor: badge.color + '44',
                    }}
                  >
                    {badge.text}
                  </span>
                  <span style={S.progressDetail}>{p.detail}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 700,
  },
  pageTitle: {
    fontSize: '1.25rem',
    fontWeight: 700,
    marginBottom: '0.3rem',
  },
  pageDesc: {
    fontSize: '0.85rem',
    color: 'var(--text-secondary)',
    marginBottom: '1rem',
    lineHeight: 1.5,
  },

  /* Tabs */
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    marginBottom: '1rem',
  },
  tab: {
    padding: '0.45rem 1rem',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  tabActive: {
    background: '#7aa2f722',
    color: '#7aa2f7',
    borderColor: '#7aa2f744',
  },

  /* Section */
  section: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1rem',
  },

  /* Quick Add */
  label: {
    display: 'block',
    fontSize: '0.82rem',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '0.35rem',
  },
  textarea: {
    width: '100%',
    padding: '0.6rem',
    borderRadius: 6,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.88rem',
    fontFamily: 'monospace',
    resize: 'vertical' as const,
  },
  info: {
    fontSize: '0.78rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
    marginTop: '0.4rem',
  },

  /* Advanced Add */
  tableHeader: {
    display: 'flex',
    gap: '0.4rem',
    marginBottom: '0.35rem',
    paddingRight: 36, // space for delete button
  },
  thCell: {
    fontSize: '0.75rem',
    fontWeight: 700,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  tableRow: {
    display: 'flex',
    gap: '0.4rem',
    marginBottom: '0.3rem',
    alignItems: 'center',
  },
  rowInput: {
    padding: '0.45rem 0.5rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    fontFamily: 'monospace',
  },
  rowDeleteBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: '#f7768e',
    fontWeight: 700,
    fontSize: '0.8rem',
    cursor: 'pointer',
    flexShrink: 0,
  },
  addRowBtn: {
    padding: '0.35rem 0.7rem',
    borderRadius: 4,
    border: '1px dashed var(--border)',
    background: 'transparent',
    color: 'var(--accent)',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: '0.25rem',
  },

  /* Actions */
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: '0.75rem',
  },
  submitBtn: {
    padding: '0.45rem 1rem',
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontWeight: 600,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  cancelBtn: {
    padding: '0.35rem 0.8rem',
    borderRadius: 6,
    border: '1px solid #f7768e44',
    background: '#f7768e22',
    color: '#f7768e',
    fontWeight: 600,
    fontSize: '0.82rem',
    cursor: 'pointer',
  },

  /* Progress */
  summary: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.75rem',
    fontSize: '0.9rem',
    fontWeight: 600,
  },
  progressList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.3rem',
  },
  progressItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    padding: '0.45rem 0.6rem',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: '0.85rem',
  },
  progressAddr: {
    fontFamily: 'monospace',
    fontWeight: 600,
    minWidth: 130,
    color: 'var(--text-primary)',
  },
  progressBadge: {
    fontSize: '0.72rem',
    fontWeight: 600,
    padding: '0.15rem 0.45rem',
    borderRadius: 4,
    border: '1px solid',
    whiteSpace: 'nowrap' as const,
    minWidth: 70,
    textAlign: 'center' as const,
  },
  progressDetail: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
};
