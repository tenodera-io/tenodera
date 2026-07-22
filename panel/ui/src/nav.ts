// Single source of truth for the app's navigation: primary pages, admin-only
// pages, and the per-page sub-tabs. Both the Sidebar and the Ctrl/Cmd+K command
// palette build their entries from this, so they never drift apart.
import type { IconName } from './components/Icons.tsx';

export interface NavItem { path: string; label: string; icon: IconName; }
export interface NavSection { label: string; items: NavItem[]; }
// `superuser: true` hides the sub-tab unless Administrative access is on — used
// for entries that read privileged host state as root (e.g. the disk-usage
// scanner), so they aren't offered in Limited mode.
export interface SubItem { id: string; label: string; superuser?: boolean; }

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'System',
    items: [
      { path: '/', label: 'Dashboard', icon: 'dashboard' },
      { path: '/services', label: 'Services', icon: 'services' },
      { path: '/containers', label: 'Containers', icon: 'containers' },
      { path: '/storage', label: 'Storage', icon: 'storage' },
      { path: '/networking', label: 'Networking', icon: 'networking' },
      { path: '/packages', label: 'Packages', icon: 'packages' },
      { path: '/users', label: 'Users', icon: 'users' },
      { path: '/cron', label: 'Cron Jobs', icon: 'cron' },
      { path: '/dns', label: 'DNS', icon: 'dns' },
      { path: '/certificates', label: 'Certificates', icon: 'certificates' },
      { path: '/system', label: 'System', icon: 'system' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { path: '/logs', label: 'Logs', icon: 'logs' },
      { path: '/log-files', label: 'Log Files', icon: 'logFiles' },
      { path: '/files', label: 'Files', icon: 'files' },
      { path: '/kdump', label: 'Kernel Dump', icon: 'kdump' },
    ],
  },
];

// Visible only when superuser mode is active (these routes redirect to / otherwise).
export const ADMIN_ITEMS: NavItem[] = [
  { path: '/terminal', label: 'Terminal', icon: 'terminal' },
  { path: '/management', label: 'Management', icon: 'management' },
  { path: '/ssh', label: 'SSH access', icon: 'key' },
  { path: '/security', label: 'Security', icon: 'shield' },
  { path: '/audit', label: 'Audit log', icon: 'audit' },
  { path: '/api-docs', label: 'API', icon: 'api' },
];

// Sub-tabs mirrored into the sidebar. The first entry is the default tab
// (represented by the absence of ?tab= — see useTabParam).
export const SUBNAV: Record<string, SubItem[]> = {
  '/services': [
    { id: 'services', label: 'Services' },
    { id: 'timers', label: 'Timers' },
  ],
  '/storage': [
    { id: 'overview', label: 'Overview' },
    { id: 'mounts', label: 'Mounts' },
    { id: 'usage', label: 'Disk usage', superuser: true },
  ],
  '/networking': [
    { id: 'overview', label: 'Overview' },
    { id: 'firewall', label: 'Firewall' },
    { id: 'interfaces', label: 'Interfaces' },
    { id: 'ports', label: 'Ports' },
    { id: 'logs', label: 'Logs' },
  ],
  '/containers': [
    { id: 'containers', label: 'Containers' },
    { id: 'images', label: 'Images' },
    { id: 'volumes', label: 'Volumes' },
    { id: 'networks', label: 'Networks' },
    { id: 'create', label: '+ New Container' },
  ],
  '/packages': [
    { id: 'installed', label: 'Installed' },
    { id: 'search', label: 'Search' },
    { id: 'updates', label: 'Updates' },
    { id: 'repos', label: 'Repositories' },
    { id: 'autoupdate', label: 'Auto-updates' },
  ],
  '/users': [
    { id: 'users', label: 'Users' },
    { id: 'groups', label: 'Groups' },
    { id: 'create', label: 'Create Account' },
  ],
  '/dns': [
    { id: 'resolver', label: 'Resolver' },
    { id: 'hosts', label: '/etc/hosts' },
    { id: 'lookup', label: 'Lookup' },
    { id: 'resolved', label: 'systemd-resolved' },
  ],
  '/certificates': [
    { id: 'certs', label: 'Certificates' },
    { id: 'trust', label: 'Trust Store' },
    { id: 'letsencrypt', label: "Let's Encrypt" },
    { id: 'selfsigned', label: 'Self-Signed' },
  ],
  '/management': [
    { id: 'hosts', label: 'Hosts' },
    { id: 'pending', label: 'Pending' },
    { id: 'tokens', label: 'Tokens' },
  ],
  '/ssh': [
    { id: 'keys', label: 'Authorized keys' },
    { id: 'sshd', label: 'Server config' },
  ],
  // The time-sync sub-tab is conditional per host (only when the daemon has a
  // management tab). System.tsx redirects ?tab=timesync back to Settings and
  // cleans the URL on hosts where it isn't available.
  '/system': [
    { id: 'settings', label: 'Settings' },
    { id: 'timesync', label: 'Time sync' },
  ],
};

export interface Command {
  id: string;
  label: string;   // e.g. "Networking" or "Networking → Ports"
  path: string;
  tab?: string;    // undefined = default tab (no ?tab=)
  icon: IconName;
  section: string; // 'System' | 'Tools' | 'Admin'
}

// Flatten the nav into a searchable command list: one entry per page, plus one
// per sub-tab (labelled "Page → Tab"). Admin pages are included only when
// superuser mode is active, mirroring the sidebar and the route guards.
export function buildCommands(suActive: boolean): Command[] {
  const sections: NavSection[] = [
    ...NAV_SECTIONS,
    ...(suActive ? [{ label: 'Admin', items: ADMIN_ITEMS }] : []),
  ];
  const cmds: Command[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      cmds.push({
        id: item.path,
        label: item.label,
        path: item.path,
        icon: item.icon,
        section: section.label,
      });
      const subs = SUBNAV[item.path];
      subs?.forEach((s, i) => {
        if (s.superuser && !suActive) return;
        cmds.push({
          id: `${item.path}#${s.id}`,
          label: `${item.label} → ${s.label}`,
          path: item.path,
          tab: i === 0 ? undefined : s.id,
          icon: item.icon,
          section: section.label,
        });
      });
    }
  }
  return cmds;
}
