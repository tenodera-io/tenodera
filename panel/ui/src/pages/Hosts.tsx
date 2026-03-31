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
  const [submitting, setSubmitting] = useState(false);

  const chRef = useRef<Channel | null>(null);

  // Tracks original address/port when editing (to detect changes)
  const editOrigRef = useRef<{ address: string; ssh_port: number; host_key: string }>({ address: '', ssh_port: 22, host_key: '' });

  // When keyscan returns during auto-submit, this ref tells handleData to proceed with add/edit
  const pendingSubmitRef = useRef<{ name: string; address: string; user: string; ssh_port: number } | null>(null);

  /* ── handle incoming data from the channel ── */
  const resetForm = useCallback(() => {
    setFormMode('closed');
    setEditId('');
    setNewName(''); setNewAddr(''); setNewUser(''); setNewSshPort('22');
    setFormError('');
    setTried(false);
    setSubmitting(false);
    pendingSubmitRef.current = null;
    editOrigRef.current = { address: '', ssh_port: 22, host_key: '' };
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
      // Auto-submit: keyscan completed during add/edit flow
      const pending = pendingSubmitRef.current;
      if (!pending) return; // stale response

      if (d.ok) {
        const host_key = (d.host_key as string) || '';
        const common = { ...pending, host_key };
        if (formMode === 'edit') {
          chRef.current?.send({ action: 'edit', id: editId, ...common });
        } else {
          chRef.current?.send({ action: 'add', ...common });
        }
      } else {
        // Keyscan failed — show error, let user retry
        pendingSubmitRef.current = null;
        setSubmitting(false);
        setFormError((d.error as string) || 'Host key scan failed — check address and port');
      }
    } else if (action === 'add') {
      pendingSubmitRef.current = null;
      setSubmitting(false);
      if (d.ok) {
        resetForm();
        refreshList();
      } else {
        setFormError((d.error as string) || 'Failed to add host');
      }
    } else if (action === 'edit') {
      pendingSubmitRef.current = null;
      setSubmitting(false);
      if (d.ok) {
        resetForm();
        refreshList();
      } else {
        setFormError((d.error as string) || 'Failed to edit host');
      }
    } else if (action === 'remove' && d.ok) {
      refreshList();
    }
  }, [resetForm, refreshList, formMode, editId]);

  const handleDataRef = useRef(handleData);
  handleDataRef.current = handleData;

  /* ── open channel ── */
  useEffect(() => {
    const ch = openChannel('hosts.manage');
    chRef.current = ch;

    ch.onMessage((msg) => {
      if (msg.type === 'data' && 'data' in msg) {
        handleDataRef.current(msg.data as Record<string, unknown>);
      }
    });

    ch.send({ action: 'list' });

    return () => { ch.close(); };
  }, []);

  /* ── submit (add or edit) — auto keyscan + save ── */
  const handleSubmit = () => {
    setTried(true);
    if (!newName || !newAddr) { setFormError('Name and address are required'); return; }

    const ssh_port = parseInt(newSshPort, 10) || 22;

    // Duplicate check (address + port), exclude current host in edit mode
    const duplicate = hosts.find((h) =>
      h.address === newAddr && h.ssh_port === ssh_port && (formMode !== 'edit' || h.id !== editId)
    );
    if (duplicate) {
      setFormError(`Host ${newAddr}:${ssh_port} already exists (${duplicate.name})`);
      return;
    }

    setFormError('');
    setSubmitting(true);

    const common = { name: newName, address: newAddr, user: newUser, ssh_port };

    // Edit mode: skip re-scan if address and port unchanged
    if (formMode === 'edit') {
      const orig = editOrigRef.current;
      if (newAddr === orig.address && ssh_port === orig.ssh_port && orig.host_key) {
        // No change — send edit directly with existing key
        chRef.current?.send({ action: 'edit', id: editId, ...common, host_key: orig.host_key });
        return;
      }
    }

    // Keyscan first, then add/edit on success (handled in handleData)
    pendingSubmitRef.current = common;
    chRef.current?.send({ action: 'keyscan', address: newAddr, ssh_port });
  };

  const handleEdit = (h: HostEntry) => {
    setFormMode('edit');
    setEditId(h.id);
    setNewName(h.name);
    setNewAddr(h.address);
    setNewUser(h.user);
    setNewSshPort(String(h.ssh_port));
    setFormError('');
    setSubmitting(false);
    editOrigRef.current = { address: h.address, ssh_port: h.ssh_port, host_key: h.host_key || '' };
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
            onChange={e => setNewName(e.target.value)} autoFocus disabled={submitting} />

          <label style={S.label}>Address (IP or hostname)</label>
          <input style={{ ...S.input, borderColor: tried && !newAddr ? '#f7768e' : newAddr ? '#7aa2f7' : '#9ece6a' }} placeholder="e.g. 192.168.56.10" value={newAddr}
            onChange={e => setNewAddr(e.target.value)} disabled={submitting} />

          <label style={S.label}>SSH User (empty = logged-in user)</label>
          <input style={{ ...S.input, borderColor: newUser ? '#7aa2f7' : '#9ece6a' }} placeholder="leave empty for your login" value={newUser}
            onChange={e => setNewUser(e.target.value)} disabled={submitting} />

          <label style={S.label}>SSH Port</label>
          <input style={{ ...S.input, borderColor: newSshPort && newSshPort !== '22' ? '#7aa2f7' : '#9ece6a' }} placeholder="22" value={newSshPort}
            onChange={e => setNewSshPort(e.target.value)} disabled={submitting} />

          {submitting && (
            <div style={S.submittingMsg}>
              Scanning host key and saving...
            </div>
          )}

          <div style={S.modalActions}>
            <button type="button" style={S.cancelBtn} onClick={resetForm} disabled={submitting}>Cancel</button>
            <button
              type="button"
              style={{ ...S.submitBtn, opacity: submitting || !newName || !newAddr ? 0.5 : 1 }}
              disabled={submitting || !newName || !newAddr}
              onClick={handleSubmit}
            >
              {submitting ? 'Adding...' : formMode === 'edit' ? 'Save' : 'Add Host'}
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
                  <span style={S.keyBadgeWarn} title="No host key stored">&#x26A0;</span>
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
    maxHeight: 150,
    overflowY: 'auto' as const,
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
  submittingMsg: {
    fontSize: '0.82rem',
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
    marginTop: '0.75rem',
  },
};
