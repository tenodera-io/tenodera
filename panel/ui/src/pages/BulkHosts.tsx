import { useState, useRef, useCallback, useEffect } from 'react';
import { openChannel, request, type Message } from '../api/transport.ts';

/* ── Types ─────────────────────────────────────────────── */

type Tab = 'quick' | 'advanced';

interface AdvancedRow {
  address: string;
  user: string;
  port: string;
}

interface HostEntry {
  id: string;
  name: string;
  address: string;
  user: string;
  ssh_port: number;
  host_key: string;
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

  /* Host list state */
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [hostStatuses, setHostStatuses] = useState<Record<string, 'unknown' | 'ok' | 'error'>>({});

  /* Edit modal state */
  const [editHost, setEditHost] = useState<HostEntry | null>(null);
  const [editName, setEditName] = useState('');
  const [editAddr, setEditAddr] = useState('');
  const [editUser, setEditUser] = useState('');
  const [editPort, setEditPort] = useState('22');
  const [editError, setEditError] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const editOrigRef = useRef<{ address: string; ssh_port: number; host_key: string }>({ address: '', ssh_port: 22, host_key: '' });

  /* ── load host list ── */
  const loadHosts = useCallback(() => {
    const ch = openChannel('hosts.manage');
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;
        if (d.action === 'list' && d.hosts) {
          setHosts(d.hosts as HostEntry[]);
        }
      }
    });
    ch.send({ action: 'list' });
    setTimeout(() => ch.close(), 2000);
  }, []);

  /* Load hosts on mount */
  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  /* Probe host connectivity — on mount and every 15s */
  useEffect(() => {
    if (hosts.length === 0) return;
    let cancelled = false;
    const probe = () => {
      for (const h of hosts) {
        request('system.info', { host: h.id })
          .then(() => { if (!cancelled) setHostStatuses((prev) => ({ ...prev, [h.id]: 'ok' })); })
          .catch(() => { if (!cancelled) setHostStatuses((prev) => ({ ...prev, [h.id]: 'error' })); });
      }
    };
    probe();
    const interval = setInterval(probe, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [hosts]);

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
      loadHosts();
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
      loadHosts();
      return;
    }

    updateProgress(idx, { step: 'done', detail: `Done (${realHostname})`, hostname: realHostname });
    loadHosts();
  }, [updateProgress, loadHosts]);

  /* ── start processing all hosts sequentially ── */
  const startProcessing = useCallback(async (entries: HostProgress[], skipCount = 0) => {
    setProcessing(true);
    cancelledRef.current = false;
    queueRef.current = entries;
    activeIdxRef.current = skipCount;
    setProgress([...entries]);

    for (let i = skipCount; i < entries.length; i++) {
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

    // Filter out duplicates (already in hosts list)
    const dupes: string[] = [];
    const fresh: string[] = [];
    for (const addr of addrs) {
      if (isDuplicate(addr, 22)) {
        dupes.push(addr);
      } else {
        fresh.push(addr);
      }
    }

    const entries: HostProgress[] = [
      ...dupes.map((addr) => ({
        address: addr, user: '', port: 22,
        step: 'error' as HostStep,
        detail: `Already exists (${addr}:22)`,
      })),
      ...fresh.map((addr) => ({
        address: addr, user: '', port: 22,
        step: 'pending' as HostStep,
        detail: 'Waiting...',
      })),
    ];

    if (fresh.length === 0) {
      // All duplicates — show results but don't process
      setProgress(entries);
      return;
    }

    startProcessing(entries, dupes.length);
  };

  /* ── Advanced Add submit ── */
  const handleAdvancedSubmit = () => {
    const valid = rows.filter((r) => r.address.trim());
    if (valid.length === 0) return;

    const dupes: { address: string; user: string; port: number }[] = [];
    const fresh: { address: string; user: string; port: number }[] = [];
    for (const r of valid) {
      const addr = r.address.trim();
      const port = parseInt(r.port, 10) || 22;
      if (isDuplicate(addr, port)) {
        dupes.push({ address: addr, user: r.user.trim(), port });
      } else {
        fresh.push({ address: addr, user: r.user.trim(), port });
      }
    }

    const entries: HostProgress[] = [
      ...dupes.map((d) => ({
        address: d.address, user: d.user, port: d.port,
        step: 'error' as HostStep,
        detail: `Already exists (${d.address}:${d.port})`,
      })),
      ...fresh.map((f) => ({
        address: f.address, user: f.user, port: f.port,
        step: 'pending' as HostStep,
        detail: 'Waiting...',
      })),
    ];

    if (fresh.length === 0) {
      setProgress(entries);
      return;
    }

    startProcessing(entries, dupes.length);
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

  /* ── Remove host from list ── */
  const handleRemoveHost = useCallback((id: string) => {
    const ch = openChannel('hosts.manage');
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;
        if (d.action === 'remove') {
          ch.close();
          if (d.ok) loadHosts();
        }
      }
    });
    ch.send({ action: 'remove', id });
    setTimeout(() => ch.close(), 5000);
  }, [loadHosts]);

  /* ── Duplicate check (address + port) ── */
  const isDuplicate = useCallback((address: string, port: number, excludeId?: string) => {
    return hosts.some((h) => h.address === address && h.ssh_port === port && h.id !== excludeId);
  }, [hosts]);

  /* ── Edit modal helpers ── */
  const openEditModal = useCallback((h: HostEntry) => {
    setEditHost(h);
    setEditName(h.name);
    setEditAddr(h.address);
    setEditUser(h.user);
    setEditPort(String(h.ssh_port));
    setEditError('');
    setEditSubmitting(false);
    editOrigRef.current = { address: h.address, ssh_port: h.ssh_port, host_key: h.host_key || '' };
  }, []);

  const closeEditModal = useCallback(() => {
    setEditHost(null);
    setEditError('');
    setEditSubmitting(false);
  }, []);

  const handleEditSubmit = useCallback(() => {
    if (!editHost) return;
    if (!editName || !editAddr) { setEditError('Name and address are required'); return; }
    const port = parseInt(editPort, 10) || 22;

    if (isDuplicate(editAddr, port, editHost.id)) {
      setEditError(`Host ${editAddr}:${port} already exists`);
      return;
    }

    setEditError('');
    setEditSubmitting(true);

    const orig = editOrigRef.current;
    const common = { name: editName, address: editAddr, user: editUser, ssh_port: port };

    // If address/port unchanged, edit directly with existing key
    if (editAddr === orig.address && port === orig.ssh_port && orig.host_key) {
      const ch = openChannel('hosts.manage');
      ch.onMessage((msg: Message) => {
        if (msg.type === 'data' && 'data' in msg) {
          const d = msg.data as Record<string, unknown>;
          if (d.action === 'edit') {
            ch.close();
            setEditSubmitting(false);
            if (d.ok) { closeEditModal(); loadHosts(); }
            else { setEditError((d.error as string) || 'Edit failed'); }
          }
        }
      });
      ch.send({ action: 'edit', id: editHost.id, ...common, host_key: orig.host_key });
      setTimeout(() => ch.close(), 10_000);
      return;
    }

    // Address/port changed — keyscan first, then edit
    const ch = openChannel('hosts.manage');
    let gotKey = false;
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as Record<string, unknown>;
        if (d.action === 'keyscan' && !gotKey) {
          gotKey = true;
          if (!d.ok) {
            ch.close();
            setEditSubmitting(false);
            setEditError((d.error as string) || 'Host key scan failed');
            return;
          }
          const host_key = (d.host_key as string) || '';
          ch.send({ action: 'edit', id: editHost.id, ...common, host_key });
        } else if (d.action === 'edit') {
          ch.close();
          setEditSubmitting(false);
          if (d.ok) { closeEditModal(); loadHosts(); }
          else { setEditError((d.error as string) || 'Edit failed'); }
        }
      }
    });
    ch.send({ action: 'keyscan', address: editAddr, ssh_port: port });
    setTimeout(() => ch.close(), 20_000);
  }, [editHost, editName, editAddr, editUser, editPort, isDuplicate, closeEditModal, loadHosts]);

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
    <div>
      <h2 style={S.pageTitle}>Manage Hosts</h2>
      <p style={S.pageDesc}>
        Bulk add remote hosts. Each host is automatically key-scanned, added, and renamed
        to its real hostname via SSH.
      </p>

      <div style={S.columns}>
        {/* ── Left column: add form / progress ── */}
        <div style={S.leftCol}>
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

        {/* ── Right column: host list ── */}
        <div style={S.rightCol}>
          <div style={S.hostListHeader}>
            <span style={S.hostListTitle}>Remote Hosts</span>
            <span style={S.hostCount}>{hosts.length}</span>
          </div>
          <div style={S.section}>
            {hosts.length === 0 ? (
              <div style={S.emptyList}>No remote hosts configured.</div>
            ) : (
              <div style={S.hostList}>
                {hosts.map((h) => {
                  const st = hostStatuses[h.id] ?? 'unknown';
                  const dotColor = st === 'ok' ? '#9ece6a' : st === 'error' ? '#f7768e' : '#565f89';
                  return (
                    <div key={h.id} style={S.hostItem}>
                      <span style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: dotColor,
                        boxShadow: st !== 'unknown' ? `0 0 4px ${dotColor}` : 'none',
                        flexShrink: 0,
                      }} title={st === 'ok' ? 'Online' : st === 'error' ? 'Offline' : 'Checking...'} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={S.hostName}>{h.name}</div>
                        <div style={S.hostAddr}>
                          {h.user ? h.user : '(session user)'}@{h.address}{h.ssh_port !== 22 ? `:${h.ssh_port}` : ''}
                        </div>
                      </div>
                      <button
                        style={S.hostEditBtn}
                        onClick={() => openEditModal(h)}
                        title="Edit host"
                      >
                        &#x270E;
                      </button>
                      <button
                        style={S.hostRemoveBtn}
                        onClick={() => handleRemoveHost(h.id)}
                        title="Remove host"
                      >
                        &#x2715;
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Edit host modal ── */}
      {editHost && (
        <div style={S.modalOverlay} onClick={closeEditModal}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={S.modalTitle}>Edit Host</h3>
            {editError && <div style={S.modalError}>{editError}</div>}

            <label style={S.label}>Name</label>
            <input
              style={{ ...S.modalInput, borderColor: editName ? '#7aa2f7' : '#9ece6a' }}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={editSubmitting}
              autoFocus
            />

            <label style={S.label}>Address</label>
            <input
              style={{ ...S.modalInput, borderColor: editAddr ? '#7aa2f7' : '#9ece6a' }}
              value={editAddr}
              onChange={(e) => setEditAddr(e.target.value)}
              disabled={editSubmitting}
            />

            <label style={S.label}>SSH User (empty = session user)</label>
            <input
              style={{ ...S.modalInput, borderColor: editUser ? '#7aa2f7' : '#9ece6a' }}
              value={editUser}
              onChange={(e) => setEditUser(e.target.value)}
              disabled={editSubmitting}
            />

            <label style={S.label}>SSH Port</label>
            <input
              style={{ ...S.modalInput, borderColor: editPort && editPort !== '22' ? '#7aa2f7' : '#9ece6a' }}
              value={editPort}
              onChange={(e) => setEditPort(e.target.value)}
              disabled={editSubmitting}
            />

            {editSubmitting && (
              <div style={S.editSubmittingMsg}>Scanning host key and saving...</div>
            )}

            <div style={S.modalActions}>
              <button type="button" style={S.modalCancelBtn} onClick={closeEditModal} disabled={editSubmitting}>
                Cancel
              </button>
              <button
                type="button"
                style={{ ...S.submitBtn, opacity: editSubmitting || !editName || !editAddr ? 0.5 : 1 }}
                disabled={editSubmitting || !editName || !editAddr}
                onClick={handleEditSubmit}
              >
                {editSubmitting ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
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

  /* Two-column layout */
  columns: {
    display: 'flex',
    gap: '1.25rem',
    alignItems: 'flex-start',
  },
  leftCol: {
    flex: 3,
    minWidth: 0,
  },
  rightCol: {
    flex: 2,
    minWidth: 240,
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

  /* Host list (right column) */
  hostListHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '1rem',
    padding: '0.45rem 0',
  },
  hostListTitle: {
    fontSize: '0.9rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  hostCount: {
    fontSize: '0.72rem',
    fontWeight: 600,
    padding: '0.1rem 0.45rem',
    borderRadius: 10,
    background: '#7aa2f722',
    color: '#7aa2f7',
  },
  emptyList: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
    padding: '0.5rem 0',
  },
  hostList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.3rem',
  },
  hostItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.45rem 0.6rem',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  hostName: {
    fontWeight: 600,
    fontSize: '0.85rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: 'var(--text-primary)',
  },
  hostAddr: {
    fontSize: '0.72rem',
    color: 'var(--text-secondary)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  hostRemoveBtn: {
    background: 'transparent',
    border: 'none',
    color: '#f7768e',
    fontWeight: 700,
    fontSize: '0.85rem',
    cursor: 'pointer',
    padding: '0 0.3rem',
    flexShrink: 0,
  },
  hostEditBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--accent)',
    fontWeight: 700,
    fontSize: '0.9rem',
    cursor: 'pointer',
    padding: '0 0.3rem',
    flexShrink: 0,
  },

  /* Edit modal */
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 500,
  },
  modal: {
    background: '#1a1b26',
    border: '1px solid #292e42',
    borderRadius: 10,
    padding: '1.5rem',
    width: '100%',
    maxWidth: 420,
  },
  modalTitle: {
    fontSize: '1rem',
    fontWeight: 700,
    marginBottom: '0.75rem',
  },
  modalError: {
    color: '#f7768e',
    fontSize: '0.82rem',
    marginBottom: '0.5rem',
  },
  modalInput: {
    width: '100%',
    padding: '0.5rem 0.6rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.88rem',
    marginBottom: '0.5rem',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '0.75rem',
  },
  modalCancelBtn: {
    padding: '0.4rem 0.9rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.82rem',
  },
  editSubmittingMsg: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
    marginTop: '0.25rem',
  },
};
