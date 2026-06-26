import { useEffect, useState, useCallback } from 'react';

interface HostEntry {
  id: string;
  name: string;
  added_at: string;
  online: boolean;
}

interface HostsProps {
  onClose: () => void;
  onChange?: () => void;
}

function sessionToken(): string {
  return sessionStorage.getItem('session_id') ?? '';
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken()}`,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

export function Hosts({ onClose, onChange }: HostsProps) {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [installCmd, setInstallCmd] = useState<string | null>(null);

  const loadHosts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/hosts');
      if (res.ok) {
        const data = await res.json();
        setHosts(data.hosts ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadHosts(); }, [loadHosts]);

  const handleAdd = async () => {
    if (!newName.trim()) { setFormError('Name is required'); return; }
    setSubmitting(true);
    setFormError('');
    try {
      const res = await apiFetch('/api/hosts', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setInstallCmd(data.install_command);
        setNewName('');
        setFormOpen(false);
        await loadHosts();
        onChange?.();
      } else {
        setFormError('Failed to add host');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (id: string) => {
    await apiFetch(`/api/hosts/${id}`, { method: 'DELETE' });
    await loadHosts();
    onChange?.();
  };

  return (
    <div>
      <div style={S.header}>
        <h2 style={S.title}>Remote Hosts</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={S.refreshBtn} onClick={loadHosts} title="Refresh">&#x21BB;</button>
          <button style={S.addBtn} onClick={() => { setFormOpen(true); setInstallCmd(null); setFormError(''); }}>
            + Add Host
          </button>
          <button style={S.closeBtn} onClick={onClose}>&#x2715;</button>
        </div>
      </div>

      {formOpen && (
        <div style={S.addForm}>
          <h3 style={S.formTitle}>Add Remote Host</h3>
          <p style={S.formDesc}>
            Give the host a name. After adding, you'll get an install command to run on the target machine.
          </p>
          {formError && <div style={S.formError}>{formError}</div>}
          <label style={S.label}>Host Name</label>
          <input
            style={S.input}
            placeholder="e.g. web-server-01"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            autoFocus
            disabled={submitting}
          />
          <div style={S.formActions}>
            <button style={S.cancelBtn} onClick={() => setFormOpen(false)} disabled={submitting}>Cancel</button>
            <button style={{ ...S.submitBtn, opacity: submitting || !newName.trim() ? 0.5 : 1 }}
              disabled={submitting || !newName.trim()} onClick={handleAdd}>
              {submitting ? 'Adding...' : 'Add Host'}
            </button>
          </div>
        </div>
      )}

      {installCmd && (
        <div style={S.installBox}>
          <div style={S.installTitle}>Run this on the new host to install the bridge agent:</div>
          <code style={S.installCode}>{installCmd}</code>
          <button style={S.copyBtn} onClick={() => navigator.clipboard?.writeText(installCmd)}>Copy</button>
          <button style={S.dismissBtn} onClick={() => setInstallCmd(null)}>Dismiss</button>
        </div>
      )}

      {loading ? (
        <div style={S.empty}>Loading...</div>
      ) : hosts.length === 0 && !formOpen ? (
        <div style={S.empty}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>&#128421;&#65039;</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No remote hosts yet. Click <b>+ Add Host</b> to register a machine.
          </div>
        </div>
      ) : (
        <div style={S.list}>
          {hosts.map(h => (
            <div key={h.id} style={S.listItem}>
              <div style={{ ...S.dot, background: h.online ? '#9ece6a' : '#f7768e' }}
                title={h.online ? 'Online' : 'Offline'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.hostName}>{h.name}</div>
                <div style={S.hostMeta}>{h.online ? 'Online' : 'Offline'} · added {new Date(h.added_at).toLocaleDateString()}</div>
              </div>
              <button style={S.removeBtn} onClick={() => handleRemove(h.id)} title="Remove host">&#x2715;</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  title: { fontSize: '1.1rem', fontWeight: 700, margin: 0 },
  refreshBtn: { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' },
  addBtn: { padding: '0.4rem 0.8rem', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' },
  closeBtn: { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' },
  addForm: { background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem', marginBottom: '1rem' },
  formTitle: { fontSize: '1rem', fontWeight: 700, marginBottom: '0.4rem' },
  formDesc: { fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5 },
  formError: { color: '#f7768e', fontSize: '0.82rem', marginBottom: '0.5rem' },
  label: { display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.2rem' },
  input: { width: '100%', padding: '0.5rem 0.6rem', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.88rem', boxSizing: 'border-box' },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' },
  cancelBtn: { padding: '0.4rem 0.9rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem' },
  submitBtn: { padding: '0.4rem 0.9rem', borderRadius: 4, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' },
  installBox: { background: '#0d1117', border: '1px solid #9ece6a44', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' },
  installTitle: { fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.4rem' },
  installCode: { display: 'block', wordBreak: 'break-all', color: '#9ece6a', fontFamily: 'monospace', fontSize: '0.72rem', marginBottom: '0.5rem' },
  copyBtn: { padding: '0.2rem 0.6rem', borderRadius: 4, border: '1px solid #9ece6a44', background: '#9ece6a11', color: '#9ece6a', fontSize: '0.75rem', cursor: 'pointer', marginRight: '0.4rem' },
  dismissBtn: { padding: '0.2rem 0.6rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '0.75rem', cursor: 'pointer' },
  empty: { textAlign: 'center', padding: '2rem', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  listItem: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  hostName: { fontWeight: 700, fontSize: '0.9rem' },
  hostMeta: { fontSize: '0.75rem', color: 'var(--text-secondary)' },
  removeBtn: { background: 'transparent', border: 'none', color: '#f7768e', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', padding: '0 0.3rem' },
};
