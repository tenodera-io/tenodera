import React, { useEffect, useState, useCallback } from 'react';

interface HostEntry {
  id: string;
  name: string;
  hostname: string;
  display_name: string | null;
  added_at: string;
  last_seen: string | null;
  online: boolean;
  is_local: boolean;
  remote_ip: string | null;
}

interface HostsProps {
  onClose: () => void;
  onChange?: () => void;
}

function sessionToken(): string {
  return sessionStorage.getItem('session_id') ?? '';
}

async function apiFetch(path: string, init?: RequestInit) {
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken()}`,
      ...(init?.headers ?? {}),
    },
  });
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function Hosts({ onClose, onChange }: HostsProps) {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

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

  const handleRemove = async (id: string) => {
    await apiFetch(`/api/hosts/${id}`, { method: 'DELETE' });
    await loadHosts();
    onChange?.();
  };

  const startEdit = (h: HostEntry) => {
    setEditingId(h.id);
    setEditValue(h.display_name ?? h.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  const saveEdit = async (id: string) => {
    const trimmed = editValue.trim();
    await apiFetch(`/api/hosts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: trimmed || null }),
    });
    setEditingId(null);
    await loadHosts();
    onChange?.();
  };

  return (
    <div>
      <div style={S.header}>
        <h2 style={S.title}>Manage Hosts</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={S.iconBtn} onClick={loadHosts} title="Refresh">&#x21BB;</button>
          <button style={S.iconBtn} onClick={onClose}>&#x2715;</button>
        </div>
      </div>

      {loading ? (
        <div style={S.empty}>Loading...</div>
      ) : hosts.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>&#128421;&#65039;</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No hosts connected yet.
          </div>
        </div>
      ) : (
        <div style={S.list}>
          {hosts.map(h => {
            const label = h.display_name ?? h.name;
            const isEditing = editingId === h.id;
            const showHostname = h.hostname && h.hostname !== label;
            return (
              <div key={h.id} style={S.row}>
                <div style={{ ...S.dot, background: h.online ? '#9ece6a' : '#565f89' }}
                  title={h.online ? 'Online' : 'Offline'} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <input
                        style={S.editInput}
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEdit(h.id);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        autoFocus
                      />
                      <button style={S.saveBtn} onClick={() => saveEdit(h.id)}>Save</button>
                      <button style={S.cancelBtn} onClick={cancelEdit}>&#x2715;</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span style={S.hostLabel}>{label}</span>
                      <button style={S.editBtn} onClick={() => startEdit(h)} title="Rename">&#x270E;</button>
                    </div>
                  )}

                  <div style={S.meta}>
                    {showHostname && <span style={S.metaChip}>{h.hostname}</span>}
                    {h.is_local && <span style={{ ...S.metaChip, color: '#7aa2f7' }}>local</span>}
                    {h.remote_ip && <span style={{ ...S.metaChip, fontFamily: 'monospace' }}>{h.remote_ip}</span>}
                    {h.online
                      ? <span style={{ color: '#9ece6a' }}>online</span>
                      : <span>last seen: {h.last_seen ? timeAgo(h.last_seen) : 'never'}</span>
                    }
                    <span style={S.metaDot}>·</span>
                    <span>added {new Date(h.added_at).toLocaleDateString()}</span>
                  </div>
                </div>

                {!h.is_local && (
                  <button style={S.removeBtn} onClick={() => handleRemove(h.id)} title="Remove host">
                    &#x2715;
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={S.hint}>
        Install bridge on a new host:
        <code style={S.hintCode}>
          curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-bridge.sh
          {' '}| sudo bash -s -- --gateway &lt;panel-url&gt;
        </code>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  header:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  title:     { fontSize: '1.1rem', fontWeight: 700, margin: 0 },
  iconBtn:   { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' },
  empty:     { textAlign: 'center', padding: '2rem', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)' },
  list:      { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  row:       { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6 },
  dot:       { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  hostLabel: { fontWeight: 700, fontSize: '0.9rem' },
  editBtn:   { background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.2rem', opacity: 0.55, lineHeight: 1 },
  editInput: { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: '0.9rem', padding: '0.2rem 0.4rem', outline: 'none', flex: 1, minWidth: 0 },
  saveBtn:   { background: '#3d59a1', border: 'none', borderRadius: 4, color: '#fff', fontSize: '0.8rem', padding: '0.2rem 0.6rem', cursor: 'pointer' },
  cancelBtn: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem', padding: '0 0.2rem' },
  meta:      { fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' },
  metaChip:  { opacity: 0.7 },
  metaDot:   { opacity: 0.4 },
  removeBtn: { background: 'transparent', border: 'none', color: '#f7768e', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', padding: '0 0.3rem', flexShrink: 0 },
  hint:      { fontSize: '0.8rem', color: 'var(--text-secondary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.6rem 0.75rem', marginTop: '0.75rem', lineHeight: 1.6 },
  hintCode:  { display: 'block', marginTop: '0.4rem', fontFamily: 'monospace', fontSize: '0.72rem', color: '#9ece6a', wordBreak: 'break-all' },
};
