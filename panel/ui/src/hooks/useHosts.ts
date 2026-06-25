import { useState, useEffect, useCallback, useRef } from 'react';
import { openChannel, request, type Message } from '../api/transport.ts';

export interface HostEntry {
  id: string;
  name: string;
  address: string;
  user: string;
  ssh_port: number;
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

export function useHosts(connected: boolean): UseHostsResult {
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [activeHost, setActiveHost] = useState<HostEntry | null>(null);
  const [hostStatuses, setHostStatuses] = useState<Record<string, HostStatus>>({});
  const [remoteStatus, setRemoteStatus] = useState<HostStatus>('unknown');
  const pendingHostId = useRef<string | null>(sessionStorage.getItem('active_host_id'));
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const loadHosts = useCallback(() => {
    const ch = openChannel('hosts.manage');
    let closed = false;
    const closeOnce = () => { if (!closed) { closed = true; ch.close(); } };
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as { action?: string; hosts?: HostEntry[] };
        if (d.action === 'list' && d.hosts) {
          setHosts(d.hosts);
          const savedId = pendingHostId.current;
          if (savedId) {
            const match = d.hosts.find((h) => h.id === savedId);
            if (match) setActiveHost(match);
            pendingHostId.current = null;
          }
          closeOnce();
        }
      }
      if (msg.type === 'close') closeOnce();
    });
    ch.send({ action: 'list' });
    setTimeout(closeOnce, 5000);
  }, []);

  const switchHost = useCallback((host: HostEntry | null) => {
    setActiveHost(host);
    if (host) sessionStorage.setItem('active_host_id', host.id);
    else sessionStorage.removeItem('active_host_id');
    setRemoteStatus('unknown');
  }, []);

  /* poll hosts list every 30s */
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(loadHosts, 30000);
    return () => clearInterval(interval);
  }, [connected, loadHosts]);

  /* probe active host connectivity */
  useEffect(() => {
    if (!activeHost || !connected) { setRemoteStatus('unknown'); return; }
    let cancelled = false;
    setRemoteStatus('unknown');
    request('system.info', { host: activeHost.id })
      .then(() => { if (!cancelled) setRemoteStatus('ok'); })
      .catch(() => { if (!cancelled) setRemoteStatus('error'); });
    return () => { cancelled = true; };
  }, [activeHost, connected]);

  /* probe all hosts every 60s */
  useEffect(() => {
    if (!connected || hosts.length === 0) return;
    let cancelled = false;
    const probe = () => {
      for (const h of hostsRef.current) {
        request('system.info', { host: h.id })
          .then(() => { if (!cancelled) setHostStatuses((prev) => ({ ...prev, [h.id]: 'ok' })); })
          .catch(() => { if (!cancelled) setHostStatuses((prev) => ({ ...prev, [h.id]: 'error' })); });
      }
    };
    probe();
    const interval = setInterval(probe, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connected, hosts.length]);

  return { hosts, activeHost, hostStatuses, remoteStatus, loadHosts, switchHost };
}
