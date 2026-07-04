import { useState, useEffect, useCallback, useRef } from 'react';
import { useToast } from '../contexts/ToastContext.tsx';

export interface HostEntry {
  id: string;
  name: string;
  added_at: string;
  online: boolean;
  is_local: boolean;
  remote_ip?: string;
  os_id?: string;
}

export type UserExistsMap = Record<string, boolean | null>;

export type HostStatus = 'unknown' | 'ok' | 'error';

export interface UseHostsResult {
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  hostStatuses: Record<string, HostStatus>;
  remoteStatus: HostStatus;
  userExistsMap: UserExistsMap;
  loadHosts: () => void;
  switchHost: (host: HostEntry | null) => void;
}

export function useHosts(_connected: boolean): UseHostsResult {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [activeHost, setActiveHost] = useState<HostEntry | null>(null);
  const [userExistsMap, setUserExistsMap] = useState<UserExistsMap>({});
  const pendingHostId = useRef<string | null>(sessionStorage.getItem('active_host_id'));
  const prevHostsRef = useRef<HostEntry[]>([]);
  const isFirstLoad = useRef(true);
  const checkedHostIds = useRef<Set<string>>(new Set());
  const toast = useToast();

  const loadHosts = useCallback(async () => {
    const sessionId = sessionStorage.getItem('session_id') ?? '';
    try {
      const res = await fetch('/api/hosts', {
        headers: { 'Authorization': `Bearer ${sessionId}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const list: HostEntry[] = data.hosts ?? [];

      // Detect newly connected / reconnected hosts (skip on first load)
      if (!isFirstLoad.current) {
        const prev = prevHostsRef.current;
        for (const h of list) {
          if (!h.online) continue;
          const prevEntry = prev.find(p => p.id === h.id);
          if (!prevEntry) {
            // Brand-new host registered
            toast.success(`Host "${h.name}" connected`);
          } else if (!prevEntry.online) {
            // Host came back online
            toast.info(`Host "${h.name}" is back online`);
          }
        }
      }
      isFirstLoad.current = false;
      prevHostsRef.current = list;

      setHosts(list);

      // Check user existence for newly-online hosts (once per host, cached).
      const toCheck = list.filter(h => h.online && !checkedHostIds.current.has(h.id));
      if (toCheck.length > 0) {
        toCheck.forEach(h => checkedHostIds.current.add(h.id));
        Promise.all(
          toCheck.map(h =>
            fetch(`/api/hosts/${h.id}/user-check`, {
              headers: { 'Authorization': `Bearer ${sessionId}` },
            })
              .then(r => r.ok ? r.json() : null)
              .then((data: { exists: boolean | null } | null) => ({ id: h.id, exists: data?.exists ?? null }))
              .catch(() => ({ id: h.id, exists: null }))
          )
        ).then(results => {
          setUserExistsMap(prev => {
            const next = { ...prev };
            results.forEach(r => { next[r.id] = r.exists; });
            return next;
          });
        });
      }

      if (pendingHostId.current) {
        const match = list.find((h) => h.id === pendingHostId.current);
        if (match) setActiveHost(match);
        pendingHostId.current = null;
      } else {
        setActiveHost((prev) => {
          if (!prev) return list.find((h) => h.is_local) ?? list[0] ?? null;
          // Update active host with fresh data; fall back to local if it was removed
          return list.find((h) => h.id === prev.id)
            ?? list.find((h) => h.is_local)
            ?? list[0]
            ?? null;
        });
      }
    } catch { /* best-effort */ }
  }, [toast]);

  const switchHost = useCallback((host: HostEntry | null) => {
    setActiveHost(host);
    if (host) sessionStorage.setItem('active_host_id', host.id);
    else sessionStorage.removeItem('active_host_id');
  }, []);

  // Refresh hosts list every 8s for quicker reconnect detection
  useEffect(() => {
    loadHosts();
    const interval = setInterval(loadHosts, 8_000);
    return () => clearInterval(interval);
  }, [loadHosts]);

  // Derive statuses from online field
  const hostStatuses: Record<string, HostStatus> = {};
  for (const h of hosts) {
    hostStatuses[h.id] = h.online ? 'ok' : 'error';
  }

  const remoteStatus: HostStatus = activeHost
    ? (activeHost.online ? 'ok' : 'error')
    : 'unknown';

  return { hosts, activeHost, hostStatuses, remoteStatus, userExistsMap, loadHosts, switchHost };
}
