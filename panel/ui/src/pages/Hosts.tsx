import { useEffect, useState, useRef, useCallback } from 'react';
import { openChannel } from '../api/transport.ts';

/* ── Types ─────────────────────────────────────────────── */

interface HostEntry {
  id: string;
  name: string;
  address: string;
  user: string;
  ssh_port: number;
  added_at: string;
  host_key: string;
}

type Channel = ReturnType<typeof openChannel>;

interface HostsProps {
  onClose: () => void;
  onChange?: () => void;
}

/* ── Component ─────────────────────────────────────────── */

export function Hosts({ onClose, onChange }: HostsProps) {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
  const [editId, setEditId] = useState('');
  const [newName, setNewName] = useState('');
  const [newAddr, setNewAddr] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newSshPort, setNewSshPort] = useState('22');
  const [formError, setFormError] = useState('');
  const [tried, setTried] = useState(false);

  // Host key verification state
  const [scanning, setScanning] = useState(false);
  const [scannedKey, setScannedKey] = useState('');
  const [scannedFingerprint, setScannedFingerprint] = useState('');
  const [keyConfirmed, setKeyConfirmed] = useState(false);

  const chRef = useRef<Channel | null>(null);

  /* ── handle incoming data from the channel ── */
  const resetForm = useCallback(() => {
    setFormMode('closed');
    setEditId('');
    setNewName(''); setNewAddr(''); setNewUser(''); setNewSshPort('22');
    setFormError('');
    setTried(false);
    setScanning(false);
    setScannedKey('');
    setScannedFingerprint('');
    setKeyConfirmed(false);
  }, []);

  const refreshList = useCallback(() => {
    chRef.current?.send({ action: 'list' });
    onChange?.();
  }, [onChange]);

  const handleData = useCallback((d: Record<string, unknown>) => {
    const action = d.action as string | undefined;

    if (action === 'list') {
      setHosts((d.hosts as HostEntry[]) || []);
    } else if (action === 'keyscan') {
      setScanning(false);
      if (d.ok) {
        setScannedKey(d.host_key as string || '');
        setScannedFingerprint(d.fingerprint as string || '');
      } else {
        setFormError((d.error as string) || 'Host key scan failed');
      }
    } else if (action === 'add') {
      if (d.ok) {
        resetForm();
        refreshList();
      } else {
        setFormError((d.error as string) || 'Failed to add host');
      }
    } else if (action === 'edit') {
      if (d.ok) {
        resetForm();
        refreshList();
      } else {
        setFormError((d.error as string) || 'Failed to edit host');
      }
    } else if (action === 'remove' && d.ok) {
      refreshList();
    }
  }, [resetForm, onChange, refreshList]);

  /* ── open channel ── */
  useEffect(() => {
    const ch = openChannel('hosts.manage');
    chRef.current = ch;

    ch.onMessage((msg) => {
      if (msg.type === 'data' && 'data' in msg) {
        handleData(msg.data as Record<string, unknown>);
      }
    });

    ch.send({ action: 'list' });

    return () => { ch.close(); };
  }, [handleData]);

  /* ── keyscan ── */
  const handleKeyscan = () => {
    setTried(true);
    if (!newName || !newAddr) { setFormError('Name and address are required'); return; }
    setFormError('');
    setScanning(true);
    setScannedKey('');
    setScannedFingerprint('');
    setKeyConfirmed(false);
    const ssh_port = parseInt(newSshPort, 10) || 22;
    chRef.current?.send({ action: 'keyscan', address: newAddr, ssh_port });
  };

  /* ── submit (add or edit) ── */
  const handleSubmit = () => {
    const ssh_port = parseInt(newSshPort, 10) || 22;
    const common = {
      name: newName,
      address: newAddr,
      user: newUser,
      ssh_port,
      host_key: scannedKey,
    };
    if (formMode === 'edit') {
      chRef.current?.send({ action: 'edit', id: editId, ...common });
    } else {
      chRef.current?.send({ action: 'add', ...common });
    }
  };

  const handleEdit = (h: HostEntry) => {
    setFormMode('edit');
    setEditId(h.id);
    setNewName(h.name);
    setNewAddr(h.address);
    setNewUser(h.user);
    setNewSshPort(String(h.ssh_port));
    setFormError('');
    setScannedKey(h.host_key || '');
    setScannedFingerprint('');
    setKeyConfirmed(!!h.host_key);
  };

  const handleRemove = (id: string) => {
    chRef.current?.send({ action: 'remove', id });
  };

  // Extract key type from host_key line (e.g. "ssh-ed25519")
  const keyType = (key: string) => {
    const parts = key.split(' ');
    return parts.length >= 2 ? parts[1] : 'unknown';
  };

  /* ── render ── */
  return (
    <div>
      {/* Header */}
      <div style={S.header}>
        <h2 style={S.title}>Manage Remote Hosts</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={S.addBtn} onClick={() => { resetForm(); setFormMode('add'); }}>
            + Add Host
          </button>
          <button style={S.closeBtn} onClick={onClose}>&#x2715;</button>
        </div>
      </div>

      {hosts.length === 0 && formMode === 'closed' && (
        <div style={S.empty}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>&#128421;&#65039;</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No remote hosts configured. Click <b>+ Add Host</b> to connect a machine with <b>tenodera-bridge</b> installed.
          </div>
        </div>
      )}

      {/* Add/Edit host form */}
      {formMode !== 'closed' && (
        <div style={S.addForm}>
          <h3 style={S.modalTitle}>{formMode === 'edit' ? 'Edit Host' : 'Add Remote Host'}</h3>
          <p style={S.formDesc}>
            The gateway connects via SSH and runs tenodera-bridge on the remote host.
            Ensure tenodera-bridge is installed on the target machine.
          </p>
          {formError && <div style={S.modalError}>{formError}</div>}

          <label style={S.label}>Name</label>
          <input style={{ ...S.input, borderColor: tried && !newName ? '#f7768e' : newName ? '#7aa2f7' : '#9ece6a' }} placeholder="e.g. Debian 12 VM" value={newName}
            onChange={e => setNewName(e.target.value)} autoFocus />

          <label style={S.label}>Address (IP or hostname)</label>
          <input style={{ ...S.input, borderColor: tried && !newAddr ? '#f7768e' : newAddr ? '#7aa2f7' : '#9ece6a' }} placeholder="e.g. 192.168.56.10" value={newAddr}
            onChange={e => { setNewAddr(e.target.value); setScannedKey(''); setScannedFingerprint(''); setKeyConfirmed(false); }} />

          <label style={S.label}>SSH User (empty = logged-in user)</label>
          <input style={{ ...S.input, borderColor: newUser ? '#7aa2f7' : '#9ece6a' }} placeholder="leave empty for your login" value={newUser}
            onChange={e => setNewUser(e.target.value)} />

          <label style={S.label}>SSH Port</label>
          <input style={{ ...S.input, borderColor: newSshPort && newSshPort !== '22' ? '#7aa2f7' : '#9ece6a' }} placeholder="22" value={newSshPort}
            onChange={e => { setNewSshPort(e.target.value); setScannedKey(''); setScannedFingerprint(''); setKeyConfirmed(false); }} />

          {/* ── Host Key Verification Section ── */}
          <div style={S.keySection}>
            <div style={S.keySectionHeader}>
              <span style={S.keySectionTitle}>SSH Host Key Verification</span>
              {scannedKey && keyConfirmed && (
                <span style={S.keyVerified}>Verified</span>
              )}
              {scannedKey && !keyConfirmed && (
                <span style={S.keyPending}>Pending confirmation</span>
              )}
              {!scannedKey && (
                <span style={S.keyMissing}>Not scanned</span>
              )}
            </div>

            {!scannedKey && !scanning && (
              <button type="button" style={S.scanBtn} onClick={handleKeyscan}>
                Scan Host Key
              </button>
            )}

            {scanning && (
              <div style={S.scanningMsg}>Scanning host key from {newAddr}:{newSshPort || '22'}...</div>
            )}

            {scannedKey && scannedFingerprint && !keyConfirmed && (
              <div style={S.keyConfirmBox}>
                <div style={S.keyConfirmLabel}>
                  Verify the fingerprint below matches the remote host:
                </div>
                <div style={S.fingerprint}>{scannedFingerprint}</div>
                <div style={S.keyConfirmLabel}>
                  Key type: <b>{keyType(scannedKey)}</b>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button type="button" style={S.confirmBtn} onClick={() => setKeyConfirmed(true)}>
                    Trust This Key
                  </button>
                  <button type="button" style={S.rejectBtn} onClick={() => { setScannedKey(''); setScannedFingerprint(''); }}>
                    Reject
                  </button>
                </div>
              </div>
            )}

            {scannedKey && keyConfirmed && (
              <div style={S.keyTrustedBox}>
                <div style={S.keyTrustedLabel}>
                  Key type: <b>{keyType(scannedKey)}</b>
                  {scannedFingerprint && <> &mdash; {scannedFingerprint}</>}
                </div>
                <button type="button" style={S.rescanBtn} onClick={handleKeyscan}>
                  Re-scan
                </button>
              </div>
            )}
          </div>

          <div style={S.modalActions}>
            <button type="button" style={S.cancelBtn} onClick={resetForm}>Cancel</button>
            <button
              type="button"
              style={{ ...S.submitBtn, opacity: !keyConfirmed ? 0.5 : 1 }}
              disabled={!keyConfirmed || !newName || !newAddr}
              onClick={handleSubmit}
              title={!keyConfirmed ? 'Scan and verify the host key first' : ''}
            >
              {formMode === 'edit' ? 'Save' : 'Add Host'}
            </button>
          </div>
        </div>
      )}

      {/* Host list */}
      <div style={S.list}>
        {hosts.map(h => (
          <div key={h.id} style={S.listItem}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.cardName}>
                {h.name}
                <span style={S.transportBadge}>SSH</span>
                {h.host_key ? (
                  <span style={S.keyBadgeOk} title={'Key: ' + keyType(h.host_key)}>&#x1F512;</span>
                ) : (
                  <span style={S.keyBadgeWarn} title="No host key — re-edit to scan">&#x26A0;</span>
                )}
              </div>
              <div style={S.cardAddr}>
                {h.user ? h.user : '(session user)'}@{h.address}{h.ssh_port !== 22 ? `:${h.ssh_port}` : ''}
              </div>
            </div>
            <button style={S.editBtn} onClick={() => handleEdit(h)} title="Edit host">&#x270E;</button>
            <button style={S.removeBtn} onClick={() => handleRemove(h.id)} title="Remove host">&#x2715;</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Styles ────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1rem',
  },
  title: {
    fontSize: '1.1rem',
    fontWeight: 700,
    margin: 0,
  },
  addBtn: {
    padding: '0.4rem 0.8rem',
    borderRadius: 6,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontWeight: 600,
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  closeBtn: {
    padding: '0.4rem 0.6rem',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontWeight: 700,
    fontSize: '0.9rem',
    cursor: 'pointer',
  },
  empty: {
    textAlign: 'center' as const,
    padding: '2rem',
    background: 'var(--bg-primary)',
    borderRadius: 8,
    border: '1px solid var(--border)',
  },
  addForm: {
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1rem',
    marginBottom: '1rem',
  },
  formDesc: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    marginBottom: '0.75rem',
    lineHeight: 1.5,
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.4rem',
  },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '0.6rem 0.75rem',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  cardName: {
    fontWeight: 700,
    fontSize: '0.9rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
  },
  transportBadge: {
    fontSize: '0.65rem',
    fontWeight: 600,
    padding: '0.1rem 0.35rem',
    borderRadius: 3,
    background: 'var(--border)',
    color: 'var(--text-secondary)',
  },
  keyBadgeOk: {
    fontSize: '0.75rem',
    cursor: 'default',
  },
  keyBadgeWarn: {
    fontSize: '0.75rem',
    cursor: 'default',
    color: '#e0af68',
  },
  cardAddr: {
    fontSize: '0.78rem',
    color: 'var(--text-secondary)',
    fontFamily: 'monospace',
  },
  editBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--accent)',
    fontWeight: 700,
    fontSize: '1rem',
    cursor: 'pointer',
    padding: '0 0.3rem',
  },
  removeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#f7768e',
    fontWeight: 700,
    fontSize: '1rem',
    cursor: 'pointer',
    padding: '0 0.3rem',
  },

  /* ── Add Form ── */
  modalTitle: {
    fontSize: '1rem',
    fontWeight: 700,
    marginBottom: '0.5rem',
  },
  modalError: {
    color: '#f7768e',
    fontSize: '0.82rem',
    marginBottom: '0.5rem',
  },
  label: {
    display: 'block',
    fontSize: '0.78rem',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '0.2rem',
    marginTop: '0.5rem',
  },
  input: {
    width: '100%',
    padding: '0.5rem 0.6rem',
    borderRadius: 4,
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '0.88rem',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '1rem',
  },
  cancelBtn: {
    padding: '0.4rem 0.9rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.82rem',
  },
  submitBtn: {
    padding: '0.4rem 0.9rem',
    borderRadius: 4,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.82rem',
  },

  /* ── Host Key Section ── */
  keySection: {
    marginTop: '0.75rem',
    padding: '0.75rem',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
  },
  keySectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.5rem',
  },
  keySectionTitle: {
    fontSize: '0.82rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  keyVerified: {
    fontSize: '0.72rem',
    fontWeight: 600,
    color: '#9ece6a',
    padding: '0.1rem 0.4rem',
    borderRadius: 3,
    border: '1px solid #9ece6a',
  },
  keyPending: {
    fontSize: '0.72rem',
    fontWeight: 600,
    color: '#e0af68',
    padding: '0.1rem 0.4rem',
    borderRadius: 3,
    border: '1px solid #e0af68',
  },
  keyMissing: {
    fontSize: '0.72rem',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    padding: '0.1rem 0.4rem',
    borderRadius: 3,
    border: '1px solid var(--border)',
  },
  scanBtn: {
    padding: '0.4rem 0.8rem',
    borderRadius: 4,
    border: '1px solid var(--accent)',
    background: 'transparent',
    color: 'var(--accent)',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.8rem',
  },
  scanningMsg: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },
  keyConfirmBox: {
    padding: '0.6rem',
    borderRadius: 4,
    border: '1px solid #e0af68',
    background: 'rgba(224, 175, 104, 0.08)',
  },
  keyConfirmLabel: {
    fontSize: '0.78rem',
    color: 'var(--text-secondary)',
    marginBottom: '0.3rem',
  },
  fingerprint: {
    fontSize: '0.82rem',
    fontFamily: 'monospace',
    color: '#e0af68',
    padding: '0.4rem 0.5rem',
    background: 'var(--bg-primary)',
    borderRadius: 4,
    border: '1px solid var(--border)',
    wordBreak: 'break-all' as const,
    marginBottom: '0.3rem',
  },
  confirmBtn: {
    padding: '0.35rem 0.7rem',
    borderRadius: 4,
    border: 'none',
    background: '#9ece6a',
    color: '#1a1b26',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.78rem',
  },
  rejectBtn: {
    padding: '0.35rem 0.7rem',
    borderRadius: 4,
    border: '1px solid #f7768e',
    background: 'transparent',
    color: '#f7768e',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.78rem',
  },
  keyTrustedBox: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '0.5rem',
  },
  keyTrustedLabel: {
    fontSize: '0.78rem',
    color: 'var(--text-secondary)',
  },
  rescanBtn: {
    padding: '0.3rem 0.6rem',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '0.72rem',
    whiteSpace: 'nowrap' as const,
  },
};
