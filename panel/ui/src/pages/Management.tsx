import { useEffect, useState, useCallback } from 'react';
import { request as rawRequest } from '../api/transport.ts';
import type { HostEntry } from '../hooks/useHosts.ts';

interface ManagementProps {
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  onSwitchHost: (host: HostEntry) => void;
}

interface HostConfig {
  roles: string[];
  hostname: string;
}

interface HostWithConfig {
  host: HostEntry;
  config: HostConfig | null;
  error?: string;
}

export function Management({ hosts, activeHost, onSwitchHost }: ManagementProps) {
  const [results, setResults] = useState<HostWithConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const settled = await Promise.allSettled(
      hosts.map(async (host): Promise<HostWithConfig> => {
        if (!host.online && !host.is_local) {
          return { host, config: null };
        }
        try {
          const opts = host.is_local ? {} : { host: host.id };
          const [data] = await rawRequest('host.config', opts);
          return { host, config: data as HostConfig };
        } catch (e) {
          return { host, config: null, error: String(e) };
        }
      }),
    );
    setResults(settled.map(r => r.status === 'fulfilled' ? r.value : { host: hosts[0], config: null }));
    setLoading(false);
  }, [hosts]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Build role → hosts map
  const groups = new Map<string, HostWithConfig[]>();
  const ungrouped: HostWithConfig[] = [];

  for (const item of results) {
    const roles = item.config?.roles ?? [];
    if (roles.length === 0) {
      ungrouped.push(item);
    } else {
      for (const role of roles) {
        if (!groups.has(role)) groups.set(role, []);
        groups.get(role)!.push(item);
      }
    }
  }

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div style={S.page}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <h2 style={S.title}>Management</h2>
        <button style={S.btn} onClick={fetchAll} disabled={loading}>↺ Refresh</button>
        {loading && <span style={S.muted}>Loading…</span>}
      </div>

      {!loading && results.length === 0 && (
        <p style={S.muted}>No hosts available.</p>
      )}

      {/* Role groups */}
      {sortedGroups.map(([role, items]) => (
        <div key={role} style={S.group}>
          <div style={S.groupHeader}>
            <span style={S.roleTag}>{role}</span>
            <span style={S.groupCount}>{items.length} host{items.length !== 1 ? 's' : ''}</span>
          </div>
          <div style={S.hostList}>
            {items.map(item => (
              <HostCard
                key={item.host.id}
                item={item}
                isActive={activeHost?.id === item.host.id}
                onSwitch={() => onSwitchHost(item.host)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Ungrouped */}
      {ungrouped.length > 0 && (
        <div style={S.group}>
          <div style={S.groupHeader}>
            <span style={{ ...S.roleTag, background: '#565f8922', color: '#565f89', borderColor: '#565f8944' }}>
              no role assigned
            </span>
            <span style={S.groupCount}>{ungrouped.length} host{ungrouped.length !== 1 ? 's' : ''}</span>
          </div>
          <div style={S.hostList}>
            {ungrouped.map(item => (
              <HostCard
                key={item.host.id}
                item={item}
                isActive={activeHost?.id === item.host.id}
                onSwitch={() => onSwitchHost(item.host)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HostCard({ item, isActive, onSwitch }: {
  item: HostWithConfig;
  isActive: boolean;
  onSwitch: () => void;
}) {
  const { host, config, error } = item;
  const online = host.online || host.is_local;
  const displayName = config?.hostname || host.name;

  return (
    <div
      style={{
        ...S.hostCard,
        borderColor: isActive ? '#7aa2f7' : online ? 'var(--border)' : '#292e42',
        opacity: online ? 1 : 0.55,
        cursor: online ? 'pointer' : 'default',
      }}
      onClick={online ? onSwitch : undefined}
      title={online ? `Switch to ${displayName}` : 'Host offline'}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: online ? '#9ece6a' : '#565f89',
          boxShadow: online ? '0 0 4px #9ece6a' : undefined,
        }} />
        <div>
          <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>
            {displayName}
            {host.is_local && <span style={S.localBadge}>local</span>}
            {isActive && <span style={S.activeBadge}>active</span>}
          </div>
          {config?.hostname && config.hostname !== host.name && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{host.name}</div>
          )}
        </div>
      </div>
      {error && <div style={{ fontSize: '0.75rem', color: '#f7768e', marginTop: '0.25rem' }}>{error}</div>}
      {!online && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>offline</div>}
    </div>
  );
}

import React from 'react';

const S: Record<string, React.CSSProperties> = {
  page:        { padding: '1.5rem', maxWidth: 900, margin: '0 auto' },
  title:       { margin: 0, fontSize: '1.4rem' },
  btn:         { padding: '0.3rem 0.8rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.83rem' },
  muted:       { color: 'var(--text-secondary)', fontSize: '0.85rem' },
  group:       { marginBottom: '1.5rem' },
  groupHeader: { display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.6rem' },
  groupCount:  { fontSize: '0.78rem', color: 'var(--text-secondary)' },
  roleTag:     { display: 'inline-block', padding: '0.2rem 0.7rem', borderRadius: 5, fontSize: '0.82rem', fontWeight: 700, fontFamily: 'monospace', background: '#7aa2f722', color: '#7aa2f7', border: '1px solid #7aa2f744' },
  hostList:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.6rem' },
  hostCard:    { background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem 1rem', transition: 'border-color 0.15s' },
  localBadge:  { marginLeft: '0.4rem', fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: '#9ece6a22', color: '#9ece6a', border: '1px solid #9ece6a44' },
  activeBadge: { marginLeft: '0.4rem', fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: '#7aa2f722', color: '#7aa2f7', border: '1px solid #7aa2f744' },
};
