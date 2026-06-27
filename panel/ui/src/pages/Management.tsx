import { useEffect, useState, useCallback, useContext, useRef } from 'react';
import { request as rawRequest } from '../api/transport.ts';
import { SuperuserContext } from '../api/SuperuserContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';
import type { HostEntry } from '../hooks/useHosts.ts';

interface ManagementProps {
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  onSwitchHost: (host: HostEntry) => void;
  onReloadHosts: () => void;
}

interface HostConfig {
  roles: string[];
  hostname: string;
  uptime_secs?: number;
}

interface HostWithConfig {
  host: HostEntry;
  config: HostConfig | null;
  error?: string;
}

export function Management({ hosts, activeHost, onSwitchHost, onReloadHosts }: ManagementProps) {
  const su = useContext(SuperuserContext);
  const [results, setResults] = useState<HostWithConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fetchGen = useRef(0);
  // Keep a ref so fetchAll doesn't need hosts in its dep array (avoids cascade
  // where every hosts poll recreates the function and restarts the fetch).
  const hostsRef = useRef<HostEntry[]>(hosts);
  hostsRef.current = hosts;

  const fetchAll = useCallback(async () => {
    const gen = ++fetchGen.current;
    setLoading(true);
    const snapshot = hostsRef.current;
    const settled = await Promise.allSettled(
      snapshot.map(async (host): Promise<HostWithConfig> => {
        if (!host.online && !host.is_local) {
          return { host, config: null };
        }
        try {
          const [data] = await rawRequest('host.config', { host: host.id });
          const config = data as HostConfig;
          if (host.is_local && !config.roles.includes('Panel / Local')) {
            config.roles = ['Panel / Local', ...config.roles];
          }
          return { host, config };
        } catch (e) {
          return { host, config: null, error: String(e) };
        }
      }),
    );
    if (gen !== fetchGen.current) return; // stale — a newer fetch is already running
    setResults(settled.map((r, i) => r.status === 'fulfilled' ? r.value : { host: snapshot[i], config: null }));
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — reads hostsRef.current at call time

  // Re-fetch when hosts list changes (new host added, host goes offline/online).
  // fetchAll is stable so this only fires on hosts change, not on every render.
  useEffect(() => { fetchAll(); }, [fetchAll, hosts]);

  const handleRemove = async (host: HostEntry) => {
    const sessionId = sessionStorage.getItem('session_id') ?? '';
    const res = await fetch(`/api/hosts/${host.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionId}` },
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    setResults(prev => prev.filter(r => r.host.id !== host.id));
    onReloadHosts();
  };

  const handleRoleChange = async (host: HostEntry, newRole: string) => {
    await rawRequest('host.action', {
      host: host.id,
      action: 'set_role',
      role: newRole,
      password: su.password,
    });
    fetchAll();
  };

  const handleRestart = async (host: HostEntry) => {
    await rawRequest('host.action', {
      host: host.id,
      action: 'restart',
      password: su.password,
    });
  };

  // Filter by search query
  const q = query.trim().toLowerCase();
  const filtered = q
    ? results.filter(item => {
        const name = (item.config?.hostname || item.host.name).toLowerCase();
        const ip   = (item.host.remote_ip ?? '').toLowerCase();
        const roles = (item.config?.roles ?? []).map(r => r.toLowerCase());
        return name.includes(q) || ip.includes(q) || roles.some(r => r.includes(q));
      })
    : results;

  // Group by role
  const groups = new Map<string, HostWithConfig[]>();
  const ungrouped: HostWithConfig[] = [];

  for (const item of filtered) {
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

  const renderGroup = (role: string, items: HostWithConfig[]) => (
    <div key={role} style={S.roleContainer}>
      <div style={S.roleHeader}>
        <span style={S.roleTitle}>{role}</span>
        <span style={S.roleCount}>{items.length} host{items.length !== 1 ? 's' : ''}</span>
      </div>
      <div style={S.hostGrid}>
        {items.map(item => (
          <HostCard
            key={item.host.id}
            item={item}
            isActive={activeHost?.id === item.host.id}
            isSelected={selectedId === item.host.id}
            onSelect={() => setSelectedId(id => id === item.host.id ? null : item.host.id)}
            onSwitch={() => onSwitchHost(item.host)}
            onRemove={() => handleRemove(item.host)}
            onRoleChange={(r) => handleRoleChange(item.host, r)}
            onRestart={() => handleRestart(item.host)}
          />
        ))}
      </div>
    </div>
  );

  const noResults = !loading && filtered.length === 0;

  return (
    <div style={S.page}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <h2 style={S.title}>Management</h2>
        <button style={S.btn} onClick={fetchAll} disabled={loading}>↺ Refresh</button>
        {loading && <span style={S.muted}>Loading…</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <input
          style={S.searchInput}
          type="search"
          placeholder="Search by hostname, IP or role…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {q && (
          <span style={S.muted}>
            {filtered.length} / {results.length} host{results.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {noResults && (
        <p style={S.muted}>{q ? 'No hosts match your search.' : 'No hosts available.'}</p>
      )}

      <div style={S.groupStack}>
        {sortedGroups.map(([role, items]) => renderGroup(role, items))}
        {ungrouped.length > 0 && renderGroup('no role assigned', ungrouped)}
      </div>
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600) % 24;
  const d = Math.floor(secs / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return iso; }
}

type CardAction = 'remove' | 'restart' | 'role' | null;

function HostCard({ item, isActive, isSelected, onSelect, onSwitch, onRemove, onRoleChange, onRestart }: {
  item: HostWithConfig;
  isActive: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onSwitch: () => void;
  onRemove: () => Promise<void>;
  onRoleChange: (role: string) => Promise<void>;
  onRestart: () => Promise<void>;
}) {
  const { host, config, error } = item;
  const online = host.online || host.is_local;
  const displayName = config?.hostname || host.name;

  const toast = useToast();
  const [activeAction, setActiveAction] = useState<CardAction>(null);
  const [roleTags, setRoleTags] = useState<string[]>([]);
  const [roleTagInput, setRoleTagInput] = useState('');
  const [busy, setBusy] = useState(false);

  const currentRoles = (config?.roles ?? []).filter(r => r !== 'Panel / Local');

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const startAction = (a: CardAction) => {
    setActiveAction(a);
    if (a === 'role') { setRoleTags([...currentRoles]); setRoleTagInput(''); }
  };
  const cancel = () => { setActiveAction(null); };

  const commitTagInput = () => {
    const val = roleTagInput.trim().replace(/,/g, '').trim();
    if (val && !roleTags.includes(val)) setRoleTags(prev => [...prev, val]);
    setRoleTagInput('');
  };

  const confirmRemove = async () => {
    setBusy(true);
    try {
      await onRemove();
      toast.success(`${displayName} removed.`);
    } catch (e) {
      toast.error(`Remove failed: ${e}`);
    } finally { setBusy(false); setActiveAction(null); }
  };

  const confirmRestart = async () => {
    setBusy(true);
    try {
      await onRestart();
      toast.warn(`Reboot initiated — ${displayName} will go offline shortly.`);
    } catch (e) {
      toast.error(`Restart failed: ${e}`);
    } finally { setBusy(false); setActiveAction(null); }
  };

  const confirmRoleChange = async () => {
    const pending = roleTagInput.trim().replace(/,/g, '').trim();
    const allTags = pending && !roleTags.includes(pending) ? [...roleTags, pending] : roleTags;
    setBusy(true);
    try {
      await onRoleChange(allTags.join(','));
      toast.success('Role updated.');
    } catch (e) {
      toast.error(`Role change failed: ${e}`);
    } finally { setBusy(false); setActiveAction(null); }
  };

  // Border priority: active > selected > online/offline
  const borderColor = isActive
    ? 'var(--c-blue)'
    : isSelected
      ? 'var(--text-3)'
      : online ? 'var(--border)' : 'var(--bg-surface)';

  const cardBg = isSelected && !isActive ? 'var(--bg-app)' : undefined;

  return (
    <div
      style={{ ...S.hostCard, borderColor, background: cardBg ?? 'var(--bg-surface)', opacity: online ? 1 : 0.6, cursor: 'pointer' }}
      onClick={onSelect}
    >
      {/* Hostname + badges */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', marginBottom: '0.55rem' }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          flexShrink: 0, marginTop: 4,
          background: online ? 'var(--c-green)' : 'var(--text-3)',
          boxShadow: online ? '0 0 4px color-mix(in srgb, var(--c-green) 53%, transparent)' : undefined,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.88rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem', alignItems: 'center' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
            {host.is_local && <span style={S.badgeGreen}>local</span>}
            {isActive && <span style={S.badgeBlue}>active</span>}
          </div>
          {config?.hostname && config.hostname !== host.name && (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-2)', marginTop: 1 }}>{host.name}</div>
          )}
        </div>
      </div>

      {/* Info rows */}
      <div style={S.infoGrid}>
        {host.remote_ip ? (
          <InfoRow label="IP" value={host.remote_ip} />
        ) : host.is_local ? (
          <InfoRow label="IP" value="127.0.0.1" />
        ) : null}
        <InfoRow label="Added" value={formatDate(host.added_at)} />
        {config?.uptime_secs !== undefined && config.uptime_secs > 0 && (
          <InfoRow label="Uptime" value={formatUptime(config.uptime_secs)} />
        )}
        {!online && <InfoRow label="Status" value="offline" valueStyle={{ color: 'var(--c-red)' }} />}
        {error && <InfoRow label="Error" value={error} valueStyle={{ color: 'var(--c-red)' }} />}
      </div>

      {/* Inline action panels — stop propagation so card click doesn't fire */}
      {activeAction === 'remove' && (
        <div style={S.confirm} onClick={stop}>
          <span style={{ fontSize: '0.8rem' }}>Remove <b>{displayName}</b> from the panel?</span>
          <div style={S.confirmBtns}>
            <button style={S.btnDanger} onClick={confirmRemove} disabled={busy}>{busy ? '…' : 'Remove'}</button>
            <button style={S.btnGhost} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      {activeAction === 'restart' && (
        <div style={S.confirm} onClick={stop}>
          <span style={{ fontSize: '0.8rem' }}>Reboot <b>{displayName}</b>?</span>
          <div style={S.confirmBtns}>
            <button style={S.btnWarn} onClick={confirmRestart} disabled={busy}>{busy ? '…' : 'Reboot'}</button>
            <button style={S.btnGhost} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      {activeAction === 'role' && (
        <div style={S.confirm} onClick={stop}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-2)', marginBottom: '0.25rem' }}>Roles:</div>
          <div style={S.tagBox} onClick={stop}>
            {roleTags.map(tag => (
              <span key={tag} style={S.tag}>
                {tag}
                <button
                  style={S.tagRemove}
                  onClick={() => setRoleTags(prev => prev.filter(t => t !== tag))}
                >×</button>
              </span>
            ))}
            <input
              style={S.tagInput}
              placeholder="Add role…"
              value={roleTagInput}
              onChange={e => {
                const v = e.target.value;
                if (v.endsWith(',')) {
                  const val = v.slice(0, -1).trim();
                  if (val && !roleTags.includes(val)) setRoleTags(prev => [...prev, val]);
                  setRoleTagInput('');
                } else {
                  setRoleTagInput(v);
                }
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commitTagInput(); }
                if (e.key === 'Escape') cancel();
                if (e.key === 'Backspace' && roleTagInput === '' && roleTags.length > 0)
                  setRoleTags(prev => prev.slice(0, -1));
              }}
              autoFocus
            />
          </div>
          <div style={S.confirmBtns}>
            <button style={S.btnPrimary} onClick={confirmRoleChange} disabled={busy}>{busy ? '…' : 'Save'}</button>
            <button style={S.btnGhost} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!activeAction && (
        <div style={S.actions} onClick={stop}>
          {online && (
            <button
              style={{ ...S.btnAction, ...(isActive ? S.btnSwitchActive : {}) }}
              onClick={onSwitch}
            >
              Switch
            </button>
          )}
          {online && <button style={S.btnAction} onClick={() => startAction('role')}>Role</button>}
          {online && !host.is_local && (
            <button style={{ ...S.btnAction, color: 'var(--c-yellow)' }} onClick={() => startAction('restart')}>
              Restart
            </button>
          )}
          {!host.is_local && (
            <button style={{ ...S.btnAction, color: 'var(--c-red)' }} onClick={() => startAction('remove')}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, valueStyle }: { label: string; value: string; valueStyle?: React.CSSProperties }) {
  return (
    <>
      <span style={S.infoLabel}>{label}</span>
      <span style={{ ...S.infoValue, ...valueStyle }}>{value}</span>
    </>
  );
}

import React from 'react';

const S: Record<string, React.CSSProperties> = {
  page:          { padding: '1.5rem', maxWidth: 1200, margin: '0 auto' },
  title:         { margin: 0, fontSize: '1.4rem' },
  btn:           { padding: '0.3rem 0.8rem', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-1)', cursor: 'pointer', fontSize: '0.83rem' },
  muted:         { color: 'var(--text-2)', fontSize: '0.85rem' },
  searchInput:   { flex: 1, maxWidth: 360, padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-1)', fontSize: '0.85rem', outline: 'none' },

  // Outer stack — one role container per row
  groupStack:    { display: 'flex', flexDirection: 'column', gap: '1rem' },

  // Dashboard-style role container (matches HOST/CPU/MEMORY card style)
  roleContainer: {
    background: 'var(--bg-panel)',
    borderRadius: '10px',
    padding: '1rem 1.25rem',
  },
  roleHeader:    { display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' },
  roleTitle:     {
    fontSize: '0.8rem',
    fontWeight: 600,
    color: 'var(--text-2)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  roleCount:     { fontSize: '0.75rem', color: 'var(--text-2)', opacity: 0.6 },

  // host cards inside each role container — multi-column grid
  hostGrid:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.65rem' },

  // Host sub-card — sits on top of bg-secondary, so uses bg-primary
  hostCard:      { background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.8rem 0.9rem', transition: 'border-color 0.15s' },

  badgeGreen:    { fontSize: '0.66rem', padding: '0.1rem 0.35rem', borderRadius: 3, background: 'color-mix(in srgb, var(--c-green) 13%, transparent)', color: 'var(--c-green)', border: '1px solid color-mix(in srgb, var(--c-green) 27%, transparent)', whiteSpace: 'nowrap' },
  badgeBlue:     { fontSize: '0.66rem', padding: '0.1rem 0.35rem', borderRadius: 3, background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)', color: 'var(--c-blue)', border: '1px solid color-mix(in srgb, var(--c-blue) 27%, transparent)', whiteSpace: 'nowrap' },

  infoGrid:      { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: '0.65rem', rowGap: '0.18rem', marginBottom: '0.65rem' },
  infoLabel:     { fontSize: '0.72rem', color: 'var(--text-2)', whiteSpace: 'nowrap', alignSelf: 'center' },
  infoValue:     { fontSize: '0.75rem', color: 'var(--text-1)', fontFamily: 'monospace', alignSelf: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  actions:         { display: 'flex', gap: '0.35rem', flexWrap: 'wrap' },
  btnAction:       { padding: '0.22rem 0.55rem', fontSize: '0.76rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer' },
  btnSwitchActive: { color: 'var(--c-green)', borderColor: 'color-mix(in srgb, var(--c-green) 33%, transparent)', background: 'color-mix(in srgb, var(--c-green) 7%, transparent)' },

  confirm:       { background: 'var(--bg-panel)', border: '1px solid var(--bg-surface)', borderRadius: 6, padding: '0.55rem', marginTop: '0.3rem', marginBottom: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' },
  confirmBtns:   { display: 'flex', gap: '0.35rem' },
  btnPrimary:    { padding: '0.22rem 0.65rem', fontSize: '0.76rem', borderRadius: 4, border: 'none', background: 'var(--c-blue)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600 },
  btnDanger:     { padding: '0.22rem 0.65rem', fontSize: '0.76rem', borderRadius: 4, border: 'none', background: 'var(--c-red)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600 },
  btnWarn:       { padding: '0.22rem 0.65rem', fontSize: '0.76rem', borderRadius: 4, border: 'none', background: 'var(--c-yellow)', color: 'var(--bg-app)', cursor: 'pointer', fontWeight: 600 },
  btnGhost:      { padding: '0.22rem 0.65rem', fontSize: '0.76rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer' },
  tagBox:        { display: 'flex', flexWrap: 'wrap', gap: '0.3rem', alignItems: 'center', background: 'var(--bg-surface)', border: '1px solid var(--bg-hover)', borderRadius: 4, padding: '0.25rem 0.4rem', minHeight: 30 },
  tag:           { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', background: 'color-mix(in srgb, var(--c-blue) 13%, transparent)', border: '1px solid color-mix(in srgb, var(--c-blue) 27%, transparent)', borderRadius: 3, padding: '0.1rem 0.35rem', fontSize: '0.75rem', color: 'var(--c-blue)' },
  tagRemove:     { background: 'none', border: 'none', color: 'var(--c-blue)', cursor: 'pointer', fontSize: '0.8rem', padding: 0, lineHeight: 1 },
  tagInput:      { border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-1)', fontSize: '0.8rem', minWidth: 80, flex: 1 },
};
