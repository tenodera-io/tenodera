import { useEffect, useState, useCallback } from 'react';

interface HostEntry {
  id: string;
  name: string;
  added_at: string;
  online: boolean;
  is_local: boolean;
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

  return (
    <div>
      <div style={S.header}>
        <h2 style={S.title}>Remote Hosts</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button style={S.refreshBtn} onClick={loadHosts} title="Refresh">&#x21BB;</button>
          <button style={S.closeBtn} onClick={onClose}>&#x2715;</button>
        </div>
      </div>

      <div style={S.hint}>
        Hosts appear here automatically when the bridge agent connects.
        To add a new host, install the bridge on it:
        <code style={S.hintCode}>
          curl -sSfL https://raw.githubusercontent.com/ultherego/Tenodera/main/install-bridge.sh
          {' '}| sudo bash -s -- --gateway &lt;panel-url&gt;
        </code>
      </div>

      {loading ? (
        <div style={S.empty}>Loading...</div>
      ) : hosts.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>&#128421;&#65039;</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            No hosts connected yet. Install the bridge agent on your servers.
          </div>
        </div>
      ) : (
        <div style={S.list}>
          {hosts.map(h => (
            <div key={h.id} style={S.listItem}>
              <div style={{ ...S.dot, background: h.online ? '#9ece6a' : '#f7768e' }}
                title={h.online ? 'Online' : 'Offline'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={S.hostName}>{h.name}{h.is_local ? ' (local)' : ''}</div>
                <div style={S.hostMeta}>{h.online ? 'Online' : 'Offline'} · added {new Date(h.added_at).toLocaleDateString()}</div>
              </div>
              {!h.is_local && (
                <button style={S.removeBtn} onClick={() => handleRemove(h.id)} title="Remove host">&#x2715;</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' },
  title: { fontSize: '1.1rem', fontWeight: 700, margin: 0 },
  refreshBtn: { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.9rem' },
  closeBtn: { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' },
  hint: { fontSize: '0.8rem', color: 'var(--text-secondary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.6rem 0.75rem', marginBottom: '0.75rem', lineHeight: 1.6 },
  hintCode: { display: 'block', marginTop: '0.4rem', fontFamily: 'monospace', fontSize: '0.72rem', color: '#9ece6a', wordBreak: 'break-all' },
  empty: { textAlign: 'center', padding: '2rem', background: 'var(--bg-primary)', borderRadius: 8, border: '1px solid var(--border)' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.4rem' },
  listItem: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 0.75rem', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  hostName: { fontWeight: 700, fontSize: '0.9rem' },
  hostMeta: { fontSize: '0.75rem', color: 'var(--text-secondary)' },
  removeBtn: { background: 'transparent', border: 'none', color: '#f7768e', fontWeight: 700, fontSize: '1rem', cursor: 'pointer', padding: '0 0.3rem' },
};

import React from 'react';
