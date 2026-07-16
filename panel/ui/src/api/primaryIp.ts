// Picks the host's primary IPv4 from a list of interfaces (as returned by
// system.info): the first usable address on an UP, non-loopback interface,
// skipping loopback (127.*) and link-local (169.254.*) addresses.
export interface IfaceLike {
  name: string;
  state?: string;
  ipv4?: string[];
}

export function pickPrimaryIp(ifaces?: IfaceLike[]): string {
  if (!ifaces) return '';
  const usable = (ip: string) => !ip.startsWith('127.') && !ip.startsWith('169.254.');
  const cands = ifaces.filter((i) => i.name !== 'lo' && i.ipv4 && i.ipv4.length > 0);
  const up = cands.filter((i) => (i.state ?? '').toUpperCase().includes('UP'));
  for (const list of [up, cands]) {
    for (const i of list) {
      const ip = (i.ipv4 ?? []).find(usable);
      if (ip) return ip;
    }
  }
  return '';
}

// The panel's own IP as the user sees it: the address they actually reached
// the panel on (window.location) is the "correct interface" by definition;
// fall back to the primary-interface heuristic when accessed by hostname.
export function preferredLocalIp(ifaces?: IfaceLike[]): string {
  const loc = typeof window !== 'undefined' ? window.location.hostname : '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(loc)) return loc;
  return pickPrimaryIp(ifaces);
}
