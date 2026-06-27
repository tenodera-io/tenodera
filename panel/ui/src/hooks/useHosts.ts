import { useState, useEffect, useCallback, useRef } from 'react';

export interface HostEntry {
  id: string;
  name: string;
  added_at: string;
  online: boolean;
  is_local: boolean;
  remote_ip?: string;
}

export type HostStatus = 'unknown' | 'ok' | 'error';

export interface UseHostsResult {
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  hostStatuses: Record<string, HostStatus>;
  remoteStatus: HostStatus;
  loadHosts: () => void;
  switchHost: (host: HostEntry | null) => void;
}

export function useHosts(_connected: boolean): UseHostsResult {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [activeHost, setActiveHost] = useState<HostEntry | null>(null);
  const pendingHostId = useRef<string | null>(sessionStorage.getItem('active_host_id'));

  const loadHosts = useCallback(async () => {
    const sessionId = sessionStorage.getItem('session_id') ?? '';
    try {
      const res = await fetch('/api/hosts', {
        headers: { 'Authorization': `Bearer ${sessionId}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const list: HostEntry[] = data.hosts ?? [];
      setHosts(list);

      if (pendingHostId.current) {
        const match = list.find((h) => h.id === pendingHostId.current);
        if (match) setActiveHost(match);
        pendingHostId.current = null;
      } else {
        setActiveHost((prev) => {
          // Auto-select the local host on first load if nothing is selected
          if (!prev) return list.find((h) => h.is_local) ?? list[0] ?? null;
          return list.find((h) => h.id === prev.id) ?? prev;
        });
      }
    } catch { /* best-effort */ }
  }, []);

  const switchHost = useCallback((host: HostEntry | null) => {
    setActiveHost(host);
    if (host) sessionStorage.setItem('active_host_id', host.id);
    else sessionStorage.removeItem('active_host_id');
  }, []);

  // Refresh hosts list every 15s
  useEffect(() => {
    loadHosts();
    const interval = setInterval(loadHosts, 15_000);
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

  return { hosts, activeHost, hostStatuses, remoteStatus, loadHosts, switchHost };
}
