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

  const chRef = useRef<Channel | null>(null);

  /* ── handle incoming data from the channel ── */
  const resetForm = useCallback(() => {
    setFormMode('closed');
    setEditId('');
    setNewName(''); setNewAddr(''); setNewUser(''); setNewSshPort('22');
    setFormError('');
    setTried(false);
  }, []);

  const refreshList = useCallback(() => {
    chRef.current?.send({ action: 'list' });
    onChange?.();
  }, [onChange]);

  const handleData = useCallback((d: Record<string, unknown>) => {
    const action = d.action as string | undefined;

    if (action === 'list') {
      setHosts((d.hosts as HostEntry[]) || []);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!newName || !newAddr) { setFormError('Name and address are required'); return; }
    const ssh_port = parseInt(newSshPort, 10) || 22;
    const common = {
      name: newName,
      address: newAddr,
      user: newUser,
      ssh_port,
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
  };

  const handleRemove = (id: string) => {
    chRef.current?.send({ action: 'remove', id });
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
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>
      </div>

      {hosts.length === 0 && formMode === 'closed' && (
        <div style={S.empty}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🖥️</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No remote hosts configured. Click <b>+ Add Host</b> to connect a machine with <b>tenodera-bridge</b> installed.
          </div>
        </div>
      )}

      {/* Add/Edit host form */}
      {formMode !== 'closed' && (
        <form style={S.addForm} onSubmit={handleSubmit}>
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
            onChange={e => setNewAddr(e.target.value)} />

          <label style={S.label}>SSH User (empty = logged-in user)</label>
          <input style={{ ...S.input, borderColor: newUser ? '#7aa2f7' : '#9ece6a' }} placeholder="leave empty for your login" value={newUser}
            onChange={e => setNewUser(e.target.value)} />

          <label style={S.label}>SSH Port</label>
          <input style={{ ...S.input, borderColor: newSshPort && newSshPort !== '22' ? '#7aa2f7' : '#9ece6a' }} placeholder="22" value={newSshPort}
            onChange={e => setNewSshPort(e.target.value)} />

          <div style={S.modalActions}>
            <button type="button" style={S.cancelBtn} onClick={resetForm}>Cancel</button>
            <button type="submit" style={S.submitBtn}>{formMode === 'edit' ? 'Save' : 'Add Host'}</button>
          </div>
        </form>
      )}

      {/* Host list */}
      <div style={S.list}>
        {hosts.map(h => (
          <div key={h.id} style={S.listItem}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.cardName}>
                {h.name}
                <span style={S.transportBadge}>SSH</span>
              </div>
              <div style={S.cardAddr}>
                {h.user ? h.user : '(session user)'}@{h.address}{h.ssh_port !== 22 ? `:${h.ssh_port}` : ''}
              </div>
            </div>
            <button style={S.editBtn} onClick={() => handleEdit(h)} title="Edit host">✎</button>
            <button style={S.removeBtn} onClick={() => handleRemove(h.id)} title="Remove host">✕</button>
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
};
