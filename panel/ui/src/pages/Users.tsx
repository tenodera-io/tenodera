import { useEffect, useState, useRef, useCallback } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { useSuperuser } from './Shell.tsx';
import type { Message } from '../api/transport.ts';

/* ── types ─────────────────────────────────────────────── */

interface UserInfo {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  groups: string[];
  locked: boolean;
  system: boolean;
  last_login: string;
}

interface GroupInfo {
  name: string;
  gid: number;
  members: string[];
  system: boolean;
}

/* ── constants ─────────────────────────────────────────── */

type Tab = 'users' | 'groups' | 'create';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'users', label: 'Users', icon: '👤' },
  { id: 'groups', label: 'Groups', icon: '👥' },
  { id: 'create', label: 'Create Account', icon: '➕' },
];

/* ── component ─────────────────────────────────────────── */

export function Users() {
  const { openChannel } = useTransport();
  const su = useSuperuser();
  const [tab, setTab] = useState<Tab>(() => {
    const saved = sessionStorage.getItem('users_tab');
    return (saved === 'groups' || saved === 'create') ? saved : 'users';
  });
  const changeTab = (t: Tab) => { setTab(t); sessionStorage.setItem('users_tab', t); };
  const [loading, setLoading] = useState(false);

  // Users
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());

  // Groups
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [groupFilter, setGroupFilter] = useState('');
  const [showSystemGroups, setShowSystemGroups] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupGid, setNewGroupGid] = useState('');

  // Available shells
  const [shells, setShells] = useState<string[]>([]);

  // Create user form
  const [newUsername, setNewUsername] = useState('');
  const [newGecos, setNewGecos] = useState('');
  const [newHome, setNewHome] = useState('');
  const [newShell, setNewShell] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [newCreateHome, setNewCreateHome] = useState(true);
  const [newForceChange, setNewForceChange] = useState(false);
  const [newGroups, setNewGroups] = useState<string[]>([]);

  // Edit modal
  const [editUser, setEditUser] = useState<UserInfo | null>(null);
  const [editShell, setEditShell] = useState('');
  const [editGecos, setEditGecos] = useState('');
  const [editGroups, setEditGroups] = useState<string[]>([]);

  // Set password modal
  const [pwUser, setPwUser] = useState<string | null>(null);
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwForce, setPwForce] = useState(false);

  // Delete confirm modal
  const [deleteUser, setDeleteUser] = useState<string | null>(null);
  const [deleteRemoveHome, setDeleteRemoveHome] = useState(false);

  // Messages
  const [actionMsg, setActionMsg] = useState('');
  const [actionError, setActionError] = useState('');

  // Groups dropdown open state
  const [newGroupsOpen, setNewGroupsOpen] = useState(false);
  const [editGroupsOpen, setEditGroupsOpen] = useState(false);
  const newGroupsRef = useRef<HTMLDivElement>(null);
  const editGroupsRef = useRef<HTMLDivElement>(null);

  // Password prompt for sudo
  const [pwPrompt, setPwPrompt] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  /* ── manage channel ────────────────────────────────────── */
  const manageRef = useRef<ReturnType<typeof openChannel> | null>(null);

  const getManageChannel = useCallback(() => {
    if (!manageRef.current) {
      manageRef.current = openChannel('users.manage');
    }
    return manageRef.current;
  }, [openChannel]);

  const sendManage = useCallback((data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    return new Promise((resolve) => {
      const ch = getManageChannel();
      const sentAction = data.action as string | undefined;
      let resolved = false;
      const handler = (msg: Message) => {
        if (resolved) return;
        if (msg.type === 'data' && 'data' in msg) {
          const res = msg.data as Record<string, unknown>;
          // If we sent an action and the response has an action field, only resolve
          // if they match — prevents cross-talk between concurrent requests
          if (sentAction && typeof res.action === 'string' && res.action !== sentAction) {
            return;
          }
          resolved = true;
          resolve(res);
        }
      };
      ch.onMessage(handler);
      ch.send(data);
    });
  }, [getManageChannel]);

  const getPassword = useCallback((): Promise<string> => {
    if (su.active && su.password) return Promise.resolve(su.password);
    return new Promise((resolve) => {
      setPwPrompt(true);
      setPwInput('');
      setPendingAction(() => () => {
        const el = document.getElementById('users-pw-input') as HTMLInputElement;
        const pw = el?.value || '';
        setPwPrompt(false);
        resolve(pw);
      });
    });
  }, [su]);

  const sudoAction = useCallback(async (actionData: Record<string, unknown>) => {
    const pw = await getPassword();
    return sendManage({ ...actionData, password: pw });
  }, [getPassword, sendManage]);

  /* ── cleanup ──────────────────────────────────────────── */
  useEffect(() => {
    return () => { manageRef.current?.close(); };
  }, []);

  /* ── close groups dropdown on outside click ── */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (newGroupsRef.current && !newGroupsRef.current.contains(e.target as Node)) setNewGroupsOpen(false);
      if (editGroupsRef.current && !editGroupsRef.current.contains(e.target as Node)) setEditGroupsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /* ── load users ───────────────────────────────────────── */
  const loadUsers = useCallback(async () => {
    setLoading(true);
    const res = await sendManage({ action: 'list' });
    setUsers((res.users as UserInfo[]) || []);
    setLoading(false);
  }, [sendManage]);

  /* ── load groups ──────────────────────────────────────── */
  const loadGroups = useCallback(async () => {
    setLoading(true);
    const res = await sendManage({ action: 'list_groups' });
    setGroups((res.groups as GroupInfo[]) || []);
    setLoading(false);
  }, [sendManage]);

  /* ── load shells ──────────────────────────────────────── */
  const loadShells = useCallback(async () => {
    const res = await sendManage({ action: 'list_shells' });
    const s = (res.shells as string[]) || [];
    setShells(s);
    if (s.length > 0) {
      setNewShell(prev => {
        if (prev) return prev;
        const bash = s.find(sh => sh.endsWith('/bash'));
        return bash || s[0];
      });
    }
  }, [sendManage]);

  useEffect(() => {
    loadUsers();
    loadShells();
    loadGroups();
  }, [loadUsers, loadShells, loadGroups]);

  /* ── filter users ─────────────────────────────────────── */
  const filteredUsers = users.filter(u => {
    if (!showSystem && u.system) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return u.username.toLowerCase().includes(q)
      || u.uid.toString().includes(q)
      || u.gecos.toLowerCase().includes(q)
      || u.groups.some(g => g.toLowerCase().includes(q))
      || u.last_login.toLowerCase().includes(q);
  });

  const filteredGroups = groups.filter(g => {
    if (!showSystemGroups && g.system) return false;
    if (!groupFilter) return true;
    const q = groupFilter.toLowerCase();
    return g.name.toLowerCase().includes(q)
      || g.gid.toString().includes(q)
      || g.members.some(m => m.toLowerCase().includes(q));
  });

  /* ── actions ──────────────────────────────────────────── */
  const clearMsg = () => { setActionMsg(''); setActionError(''); };

  const handleCreateUser = async () => {
    clearMsg();
    if (!newUsername.trim()) { setActionError('Username is required'); return; }
    if (newPassword && newPassword !== newPasswordConfirm) { setActionError('Passwords do not match'); return; }

    const res = await sudoAction({
      action: 'create',
      username: newUsername.trim(),
      gecos: newGecos.trim(),
      home: newHome.trim() || undefined,
      shell: newShell || undefined,
      create_home: newCreateHome,
      new_password: newPassword || undefined,
      force_change: newForceChange,
      groups: newGroups.length > 0 ? newGroups : undefined,
    });

    if (res.error) {
      setActionError(String(res.error));
    } else {
      setActionMsg(`User "${newUsername}" created successfully`);
      setNewUsername(''); setNewGecos(''); setNewHome('');
      setNewPassword(''); setNewPasswordConfirm('');
      setNewForceChange(false); setNewGroups([]);
      loadUsers();
      changeTab('users');
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteUser) return;
    clearMsg();
    const res = await sudoAction({
      action: 'delete',
      username: deleteUser,
      remove_home: deleteRemoveHome,
    });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`User "${deleteUser}" deleted`); loadUsers(); }
    setDeleteUser(null);
    setDeleteRemoveHome(false);
  };

  const handleLock = async (username: string) => {
    clearMsg();
    const res = await sudoAction({ action: 'lock', username });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`User "${username}" locked`); loadUsers(); }
  };

  const handleUnlock = async (username: string) => {
    clearMsg();
    const res = await sudoAction({ action: 'unlock', username });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`User "${username}" unlocked`); loadUsers(); }
  };

  const handleSetPassword = async () => {
    if (!pwUser) return;
    clearMsg();
    if (!pwNew) { setActionError('Password cannot be empty'); return; }
    if (pwNew !== pwConfirm) { setActionError('Passwords do not match'); return; }
    const res = await sudoAction({
      action: 'set_password',
      username: pwUser,
      new_password: pwNew,
      force_change: pwForce,
    });
    if (res.error) setActionError(String(res.error));
    else setActionMsg(`Password set for "${pwUser}"`);
    setPwUser(null); setPwNew(''); setPwConfirm(''); setPwForce(false);
  };

  const handleEditSave = async () => {
    if (!editUser) return;
    clearMsg();
    const res = await sudoAction({
      action: 'modify',
      username: editUser.username,
      gecos: editGecos,
      shell: editShell,
      groups: editGroups,
    });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`User "${editUser.username}" updated`); loadUsers(); }
    setEditUser(null);
  };

  const openEdit = (u: UserInfo) => {
    setEditUser(u);
    setEditShell(u.shell);
    setEditGecos(u.gecos);
    setEditGroups([...u.groups]);
  };

  const handleCreateGroup = async () => {
    clearMsg();
    if (!newGroupName.trim()) { setActionError('Group name is required'); return; }
    const gidNum = newGroupGid.trim() ? parseInt(newGroupGid.trim(), 10) : undefined;
    if (newGroupGid.trim() && (isNaN(gidNum!) || gidNum! < 0 || gidNum! > 65534)) {
      setActionError('GID must be a number between 0 and 65534');
      return;
    }
    const res = await sudoAction({
      action: 'create_group',
      name: newGroupName.trim(),
      ...(gidNum !== undefined ? { gid: gidNum } : {}),
    });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`Group "${newGroupName}" created`); setNewGroupName(''); setNewGroupGid(''); loadGroups(); }
  };

  const handleDeleteGroup = async (name: string) => {
    clearMsg();
    const res = await sudoAction({ action: 'delete_group', name });
    if (res.error) setActionError(String(res.error));
    else { setActionMsg(`Group "${name}" deleted`); loadGroups(); }
  };

  /* ── group toggle for create/edit forms ── */
  const toggleGroup = (group: string, current: string[], setter: (g: string[]) => void) => {
    if (current.includes(group)) {
      setter(current.filter(g => g !== group));
    } else {
      setter([...current, group]);
    }
  };

  const allGroupNames = groups.length > 0 ? groups.map(g => g.name) : users.length > 0
    ? [...new Set(users.flatMap(u => u.groups))].sort()
    : [];

  /* ── render ───────────────────────────────────────────── */
  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <h2 style={S.title}>👤 Users & Groups</h2>
      </div>

      {/* Messages */}
      {actionMsg && <div style={S.successMsg} onClick={() => setActionMsg('')}>{actionMsg}</div>}
      {actionError && <div style={S.errorMsg} onClick={() => setActionError('')}>{actionError}</div>}

      {/* Tabs */}
      <div style={S.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => changeTab(t.id)}
            style={tab === t.id ? { ...S.tab, ...S.tabActive } : S.tab}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={S.content}>
        {/* ── Users tab ── */}
        {tab === 'users' && (
          <div>
            <div style={S.toolbar}>
              <input
                type="text"
                placeholder="Search users..."
                value={filter}
                onChange={e => setFilter(e.target.value)}
                style={{ ...S.input, borderColor: filter ? '#7aa2f7' : '#9ece6a' }}
              />
              <label style={S.checkLabel}>
                <input
                  type="checkbox"
                  checked={showSystem}
                  onChange={e => setShowSystem(e.target.checked)}
                />
                Show system accounts
              </label>
              <button onClick={loadUsers} style={S.btn} disabled={loading}>
                {loading ? '...' : 'Refresh'}
              </button>
              <span style={S.count}>{filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}</span>
            </div>
            {/* Action toolbar for selected users */}
            {selectedUsers.size > 0 && (
              <div style={S.selToolbar}>
                <span style={S.selCount}>{selectedUsers.size} selected</span>
                {selectedUsers.size === 1 && (() => {
                  const sel = users.find(u => selectedUsers.has(u.username));
                  return sel ? (
                    <>
                      <button onClick={() => openEdit(sel)} style={S.btnSmall} title="Edit user">Edit</button>
                      <button onClick={() => { setPwUser(sel.username); setPwNew(''); setPwConfirm(''); setPwForce(false); }} style={S.btnSmall} title="Set password">Set Password</button>
                      {sel.locked
                        ? <button onClick={() => { handleUnlock(sel.username); setSelectedUsers(new Set()); }} style={S.btnSmallSuccess} title="Unlock">Unlock</button>
                        : <button onClick={() => { handleLock(sel.username); setSelectedUsers(new Set()); }} style={S.btnSmallWarn} title="Lock" disabled={sel.uid === 0}>Lock</button>
                      }
                      <button onClick={() => { setDeleteUser(sel.username); setDeleteRemoveHome(false); }} style={S.btnSmallDanger} title="Delete" disabled={sel.uid === 0}>Delete</button>
                    </>
                  ) : null;
                })()}
                {selectedUsers.size > 1 && (
                  <>
                    <button
                      onClick={async () => {
                        for (const u of selectedUsers) {
                          const usr = users.find(x => x.username === u);
                          if (usr && !usr.locked && usr.uid !== 0) await handleLock(u);
                        }
                        setSelectedUsers(new Set());
                      }}
                      style={S.btnSmallWarn}
                      title="Lock selected"
                    >Lock All</button>
                    <button
                      onClick={async () => {
                        for (const u of selectedUsers) {
                          const usr = users.find(x => x.username === u);
                          if (usr && usr.locked) await handleUnlock(u);
                        }
                        setSelectedUsers(new Set());
                      }}
                      style={S.btnSmallSuccess}
                      title="Unlock selected"
                    >Unlock All</button>
                  </>
                )}
                <button
                  onClick={() => setSelectedUsers(new Set())}
                  style={S.btnSmall}
                  title="Clear selection"
                >Clear</button>
              </div>
            )}
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, width: 36, textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={filteredUsers.length > 0 && filteredUsers.every(u => selectedUsers.has(u.username))}
                        onChange={e => {
                          if (e.target.checked) {
                            setSelectedUsers(new Set(filteredUsers.map(u => u.username)));
                          } else {
                            setSelectedUsers(new Set());
                          }
                        }}
                      />
                    </th>
                    <th style={S.th}>Username</th>
                    <th style={S.th}>UID</th>
                    <th style={S.th}>Full Name</th>
                    <th style={S.th}>Groups</th>
                    <th style={S.th}>Shell</th>
                    <th style={S.th}>Last Login</th>
                    <th style={S.th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(u => (
                    <tr
                      key={u.username}
                      style={{
                        ...S.tr,
                        background: selectedUsers.has(u.username) ? 'rgba(122,162,247,0.08)' : 'transparent',
                      }}
                    >
                      <td style={{ ...S.td, width: 36, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={selectedUsers.has(u.username)}
                          onChange={e => {
                            const next = new Set(selectedUsers);
                            if (e.target.checked) next.add(u.username);
                            else next.delete(u.username);
                            setSelectedUsers(next);
                          }}
                        />
                      </td>
                      <td style={S.td}>
                        <span style={{ fontWeight: 600 }}>{u.username}</span>
                        {u.uid === 0 && <span style={S.rootBadge}>root</span>}
                      </td>
                      <td style={S.tdMono}>{u.uid}</td>
                      <td style={S.td}>{u.gecos || '\u2014'}</td>
                      <td style={S.td}>
                        <div style={S.groupsWrap}>
                          {u.groups.length > 0 ? u.groups.map(g => (
                            <span key={g} style={S.groupBadge}>{g}</span>
                          )) : <span style={S.muted}>{'\u2014'}</span>}
                        </div>
                      </td>
                      <td style={S.tdMono}>{u.shell.split('/').pop()}</td>
                      <td style={S.td}>{u.last_login || '\u2014'}</td>
                      <td style={S.td}>
                        <span style={{ color: u.locked ? '#f7768e' : '#9ece6a', fontSize: '0.8rem' }}>
                          {u.locked ? 'Locked' : 'Active'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {loading && <div style={S.loadingText}>Loading...</div>}
          </div>
        )}

        {/* ── Groups tab ── */}
        {tab === 'groups' && (
          <div>
            <div style={S.toolbar}>
              <input
                type="text"
                placeholder="Search groups..."
                value={groupFilter}
                onChange={e => setGroupFilter(e.target.value)}
                style={{ ...S.input, borderColor: groupFilter ? '#7aa2f7' : '#9ece6a' }}
              />
              <label style={S.checkLabel}>
                <input
                  type="checkbox"
                  checked={showSystemGroups}
                  onChange={e => setShowSystemGroups(e.target.checked)}
                />
                Show system groups
              </label>
              <button onClick={loadGroups} style={S.btn} disabled={loading}>
                {loading ? '...' : 'Refresh'}
              </button>
              <span style={S.count}>{filteredGroups.length} group{filteredGroups.length !== 1 ? 's' : ''}</span>
            </div>

            {/* Add group form */}
            <div style={S.formCard}>
              <h4 style={S.formTitle}>Create Group</h4>
              <div style={S.formRow}>
                <input
                  type="text"
                  placeholder="Group name"
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
                  style={{ ...S.input, minWidth: 200, borderColor: newGroupName ? '#7aa2f7' : '#9ece6a' }}
                />
                <input
                  type="text"
                  placeholder="GID (optional)"
                  value={newGroupGid}
                  onChange={e => setNewGroupGid(e.target.value.replace(/[^0-9]/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
                  style={{ ...S.input, minWidth: 120, maxWidth: 140, borderColor: newGroupGid ? '#7aa2f7' : '#9ece6a' }}
                />
                <button onClick={handleCreateGroup} style={S.btnSuccess} disabled={!newGroupName.trim()}>
                  Create Group
                </button>
              </div>
            </div>

            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Group Name</th>
                    <th style={S.th}>GID</th>
                    <th style={S.th}>Members</th>
                    <th style={{ ...S.th, width: 80 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGroups.map(g => (
                    <tr key={g.name} style={S.tr}>
                      <td style={S.td}><span style={{ fontWeight: 600 }}>{g.name}</span></td>
                      <td style={S.tdMono}>{g.gid}</td>
                      <td style={S.td}>
                        <div style={S.groupsWrap}>
                          {g.members.length > 0 ? g.members.map(m => (
                            <span key={m} style={S.memberBadge}>{m}</span>
                          )) : <span style={S.muted}>—</span>}
                        </div>
                      </td>
                      <td style={S.td}>
                        <button
                          onClick={() => handleDeleteGroup(g.name)}
                          style={S.btnSmallDanger}
                          title="Delete group"
                          disabled={g.gid === 0}
                        >
                          Del
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {loading && <div style={S.loadingText}>Loading...</div>}
          </div>
        )}

        {/* ── Create User tab ── */}
        {tab === 'create' && (
          <div>
            <div style={S.formCard}>
              <h3 style={{ ...S.formTitle, fontSize: '1.1rem', marginBottom: '1rem' }}>Create New Account</h3>

              <div style={S.createGrid}>
                {/* Row 1: Username, Full Name */}
                <div style={S.fieldGroup}>
                  <label style={S.label}>Username *</label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={e => {
                      setNewUsername(e.target.value);
                      if (!newHome || newHome === `/home/${newUsername}` || newHome === '/home/') {
                        setNewHome(e.target.value ? `/home/${e.target.value}` : '');
                      }
                    }}
                    placeholder="e.g. jdoe"
                    style={{ ...S.inputFull, borderColor: newUsername ? '#7aa2f7' : '#9ece6a' }}
                    autoFocus
                  />
                </div>
                <div style={S.fieldGroup}>
                  <label style={S.label}>Full Name</label>
                  <input
                    type="text"
                    value={newGecos}
                    onChange={e => setNewGecos(e.target.value)}
                    placeholder="e.g. John Doe"
                    style={{ ...S.inputFull, borderColor: newGecos ? '#7aa2f7' : '#9ece6a' }}
                  />
                </div>
                <div style={S.fieldGroup}>
                  <label style={S.label}>Shell</label>
                  <select
                    value={newShell}
                    onChange={e => setNewShell(e.target.value)}
                    style={{ ...S.selectFull, borderColor: '#7aa2f7' }}
                  >
                    {shells.length === 0 && <option value="">Loading...</option>}
                    {shells.map(sh => (
                      <option key={sh} value={sh}>{sh}</option>
                    ))}
                  </select>
                </div>

                {/* Row 2: Home Directory + checkbox, Shell */}
                <div style={S.fieldGroup}>
                  <label style={S.label}>Home Directory</label>
                  <input
                    type="text"
                    value={newHome}
                    onChange={e => setNewHome(e.target.value)}
                    placeholder="/home/username"
                    style={{ ...S.inputFull, borderColor: newHome ? '#7aa2f7' : '#9ece6a' }}
                  />
                  <label style={{ ...S.checkLabel, marginTop: '0.35rem' }}>
                    <input type="checkbox" checked={newCreateHome} onChange={e => setNewCreateHome(e.target.checked)} />
                    Create home directory
                  </label>
                </div>

                {/* Row 3: Password + checkbox, Confirm Password */}
                <div style={S.fieldGroup}>
                  <label style={S.label}>Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="Leave empty for no password"
                    style={{
                      ...S.inputFull,
                      borderColor: !newPassword && !newPasswordConfirm
                        ? '#9ece6a'
                        : newPassword && newPasswordConfirm && newPassword === newPasswordConfirm
                          ? '#7aa2f7'
                          : '#f7768e',
                    }}
                    autoComplete="new-password"
                  />
                  <label style={{ ...S.checkLabel, marginTop: '0.35rem' }}>
                    <input type="checkbox" checked={newForceChange} onChange={e => setNewForceChange(e.target.checked)} />
                    Require password change on first login
                  </label>
                </div>
                <div style={S.fieldGroup}>
                  <label style={S.label}>Confirm Password</label>
                  <input
                    type="password"
                    value={newPasswordConfirm}
                    onChange={e => setNewPasswordConfirm(e.target.value)}
                    placeholder="Confirm password"
                    style={{
                      ...S.inputFull,
                      borderColor: !newPassword && !newPasswordConfirm
                        ? '#9ece6a'
                        : newPassword && newPasswordConfirm && newPassword === newPasswordConfirm
                          ? '#7aa2f7'
                          : '#f7768e',
                    }}
                    autoComplete="new-password"
                  />
                </div>

                {/* Groups dropdown */}
                <div style={{ ...S.fieldGroup, position: 'relative' as const }} ref={newGroupsRef}>
                  <label style={S.label}>Groups</label>
                  <button
                    type="button"
                    onClick={() => setNewGroupsOpen(!newGroupsOpen)}
                    style={{ ...S.dropdownBtn, borderColor: newGroups.length > 0 ? '#7aa2f7' : '#9ece6a' }}
                  >
                    <span style={S.dropdownBtnText}>
                      {newGroups.length === 0
                        ? 'Select groups...'
                        : newGroups.join(', ')}
                    </span>
                    <span style={{ fontSize: '0.65rem', opacity: 0.6 }}>{newGroupsOpen ? '\u25B2' : '\u25BC'}</span>
                  </button>
                  {newGroupsOpen && (
                    <div style={S.dropdownList}>
                      {allGroupNames.filter(g => !['root', 'nogroup', 'nobody'].includes(g)).map(g => (
                        <label key={g} style={S.dropdownItem}>
                          <input
                            type="checkbox"
                            checked={newGroups.includes(g)}
                            onChange={() => toggleGroup(g, newGroups, setNewGroups)}
                          />
                          <span>{g}</span>
                        </label>
                      ))}
                      {allGroupNames.length === 0 && <div style={{ ...S.muted, padding: '0.5rem' }}>Loading groups...</div>}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ ...S.formActions, marginTop: '1.25rem' }}>
                <button onClick={handleCreateUser} style={S.btnSuccess} disabled={!newUsername.trim()}>
                  Create Account
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Edit User Modal ── */}
      {editUser && (
        <div style={S.overlay} onClick={() => setEditUser(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h3 style={S.modalTitle}>Edit User: {editUser.username}</h3>
            <div style={S.fieldGroup}>
              <label style={S.label}>Full Name</label>
              <input type="text" value={editGecos} onChange={e => setEditGecos(e.target.value)} style={{ ...S.input, borderColor: editGecos ? '#7aa2f7' : '#9ece6a' }} />
            </div>
            <div style={S.fieldGroup}>
              <label style={S.label}>Shell</label>
              <select value={editShell} onChange={e => setEditShell(e.target.value)} style={{ ...S.select, borderColor: '#7aa2f7' }}>
                {shells.map(sh => (<option key={sh} value={sh}>{sh}</option>))}
                {!shells.includes(editShell) && <option value={editShell}>{editShell}</option>}
              </select>
            </div>
            <div style={{ ...S.fieldGroup, position: 'relative' as const }} ref={editGroupsRef}>
              <label style={S.label}>Groups</label>
              <button
                type="button"
                onClick={() => setEditGroupsOpen(!editGroupsOpen)}
                style={{ ...S.dropdownBtn, borderColor: editGroups.length > 0 ? '#7aa2f7' : '#9ece6a' }}
              >
                <span style={S.dropdownBtnText}>
                  {editGroups.length === 0
                    ? 'Select groups...'
                    : editGroups.join(', ')}
                </span>
                <span style={{ fontSize: '0.65rem', opacity: 0.6 }}>{editGroupsOpen ? '\u25B2' : '\u25BC'}</span>
              </button>
              {editGroupsOpen && (
                <div style={S.dropdownList}>
                  {allGroupNames.filter(g => !['root', 'nogroup', 'nobody'].includes(g)).map(g => (
                    <label key={g} style={S.dropdownItem}>
                      <input
                        type="checkbox"
                        checked={editGroups.includes(g)}
                        onChange={() => toggleGroup(g, editGroups, setEditGroups)}
                      />
                      <span>{g}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div style={S.modalActions}>
              <button onClick={() => setEditUser(null)} style={S.btnCancel}>Cancel</button>
              <button onClick={handleEditSave} style={S.btnSuccess}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Set Password Modal ── */}
      {pwUser && (
        <div style={S.overlay} onClick={() => setPwUser(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h3 style={S.modalTitle}>Set Password: {pwUser}</h3>
            <div style={S.fieldGroup}>
              <label style={S.label}>New Password</label>
              <input type="password" value={pwNew} onChange={e => setPwNew(e.target.value)} style={{ ...S.input, borderColor: !pwNew && !pwConfirm ? '#9ece6a' : pwNew && pwConfirm && pwNew === pwConfirm ? '#7aa2f7' : '#f7768e' }} autoComplete="new-password" autoFocus />
            </div>
            <div style={S.fieldGroup}>
              <label style={S.label}>Confirm Password</label>
              <input type="password" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} style={{ ...S.input, borderColor: !pwNew && !pwConfirm ? '#9ece6a' : pwNew && pwConfirm && pwNew === pwConfirm ? '#7aa2f7' : '#f7768e' }} autoComplete="new-password" />
            </div>
            <label style={S.checkLabel}>
              <input type="checkbox" checked={pwForce} onChange={e => setPwForce(e.target.checked)} />
              Require password change on next login
            </label>
            <div style={{ ...S.modalActions, marginTop: '1rem' }}>
              <button onClick={() => setPwUser(null)} style={S.btnCancel}>Cancel</button>
              <button onClick={handleSetPassword} style={S.btnSuccess} disabled={!pwNew || pwNew !== pwConfirm}>Set Password</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirm Modal ── */}
      {deleteUser && (
        <div style={S.overlay} onClick={() => setDeleteUser(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h3 style={S.modalTitle}>Delete User: {deleteUser}</h3>
            <p style={S.modalText}>Are you sure you want to delete user <strong>{deleteUser}</strong>?</p>
            <label style={S.checkLabel}>
              <input type="checkbox" checked={deleteRemoveHome} onChange={e => setDeleteRemoveHome(e.target.checked)} />
              Remove home directory and mail spool
            </label>
            <div style={{ ...S.modalActions, marginTop: '1rem' }}>
              <button onClick={() => setDeleteUser(null)} style={S.btnCancel}>Cancel</button>
              <button onClick={handleDeleteUser} style={S.btnDanger}>Delete User</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sudo Password Prompt ── */}
      {pwPrompt && (
        <div style={S.overlay}>
          <form style={S.modal} onSubmit={e => { e.preventDefault(); pendingAction?.(); }}>
            <h3 style={S.modalTitle}>Authentication Required</h3>
            <p style={S.modalText}>Enter your password to perform this action.</p>
            <input
              id="users-pw-input"
              type="password"
              placeholder="Password"
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              style={{ ...S.modalInput, borderColor: pwInput ? '#7aa2f7' : '#9ece6a' }}
              autoFocus
              autoComplete="current-password"
            />
            <div style={S.modalActions}>
              <button type="button" onClick={() => setPwPrompt(false)} style={S.btnCancel}>Cancel</button>
              <button type="submit" style={S.btnSuccess}>Authenticate</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────── */

const S: Record<string, React.CSSProperties> = {
  page: {
    padding: '1.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    height: '100%',
    overflow: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  title: {
    margin: 0,
    fontSize: '1.4rem',
    color: 'var(--text-primary)',
  },
  successMsg: {
    background: 'rgba(158,206,106,0.15)',
    color: '#9ece6a',
    padding: '0.5rem 1rem',
    borderRadius: 8,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  errorMsg: {
    background: 'rgba(247,118,142,0.15)',
    color: '#f7768e',
    padding: '0.5rem 1rem',
    borderRadius: 8,
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  tabs: {
    display: 'flex',
    gap: '0.25rem',
    borderBottom: '1px solid var(--border)',
  },
  tab: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    fontSize: '0.9rem',
    borderBottom: '2px solid transparent',
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    transition: 'color 0.15s',
  },
  tabActive: {
    color: 'var(--accent)',
    borderBottom: '2px solid var(--accent)',
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.75rem',
    flexWrap: 'wrap' as const,
  },
  input: {
    background: 'var(--bg-card)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: '0.85rem',
    outline: 'none',
    minWidth: 200,
  },
  select: {
    background: 'var(--bg-card)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: '0.85rem',
    outline: 'none',
    width: '100%',
  },
  btn: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap' as const,
  },
  btnSuccess: {
    background: 'rgba(158,206,106,0.2)',
    border: '1px solid #9ece6a',
    color: '#9ece6a',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
    whiteSpace: 'nowrap' as const,
  },
  btnDanger: {
    background: 'rgba(247,118,142,0.2)',
    border: '1px solid #f7768e',
    color: '#f7768e',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  btnCancel: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  btnSmall: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  btnSmallSuccess: {
    background: 'rgba(158,206,106,0.15)',
    border: '1px solid #9ece6a',
    color: '#9ece6a',
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  btnSmallWarn: {
    background: 'rgba(224,175,104,0.15)',
    border: '1px solid #e0af68',
    color: '#e0af68',
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  btnSmallDanger: {
    background: 'rgba(247,118,142,0.15)',
    border: '1px solid #f7768e',
    color: '#f7768e',
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: '0.75rem',
  },
  count: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    marginLeft: 'auto',
  },
  checkLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    cursor: 'pointer',
  },
  tableWrap: {
    overflowX: 'auto' as const,
    maxHeight: 'calc(100vh - 320px)',
    overflowY: 'auto' as const,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.85rem',
  },
  th: {
    textAlign: 'left' as const,
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontWeight: 600,
    position: 'sticky' as const,
    top: 0,
    background: 'var(--bg-base)',
    zIndex: 1,
  },
  tr: {
    borderBottom: '1px solid rgba(65,72,104,0.3)',
  },
  td: {
    padding: '6px 12px',
    color: 'var(--text-primary)',
  },
  tdMono: {
    padding: '6px 12px',
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    fontSize: '0.8rem',
  },
  rootBadge: {
    background: 'rgba(247,118,142,0.2)',
    color: '#f7768e',
    fontSize: '0.65rem',
    padding: '1px 5px',
    borderRadius: 6,
    marginLeft: 6,
    fontWeight: 700,
  },
  groupsWrap: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '3px',
  },
  groupBadge: {
    background: 'rgba(122,162,247,0.15)',
    color: '#7aa2f7',
    fontSize: '0.7rem',
    padding: '1px 6px',
    borderRadius: 8,
  },
  memberBadge: {
    background: 'rgba(158,206,106,0.15)',
    color: '#9ece6a',
    fontSize: '0.7rem',
    padding: '1px 6px',
    borderRadius: 8,
  },
  actionBtns: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap' as const,
  },
  selToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 0.75rem',
    marginBottom: '0.5rem',
    background: 'rgba(122,162,247,0.08)',
    border: '1px solid rgba(122,162,247,0.25)',
    borderRadius: 6,
  },
  selCount: {
    color: '#7aa2f7',
    fontSize: '0.85rem',
    fontWeight: 600,
    marginRight: '0.25rem',
  },
  muted: {
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
  },
  loadingText: {
    color: 'var(--text-secondary)',
    textAlign: 'center' as const,
    padding: '2rem',
  },
  formCard: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '1rem',
    marginBottom: '1rem',
  },
  formTitle: {
    margin: '0 0 0.5rem 0',
    color: 'var(--text-primary)',
    fontSize: '0.95rem',
  },
  formRow: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  formActions: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'flex-end',
    marginTop: '1rem',
  },
  createForm: {
    maxWidth: 700,
  },
  createGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: '0.75rem 1rem',
  },
  inputFull: {
    background: 'var(--bg-card)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: '0.85rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  selectFull: {
    background: 'var(--bg-card)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '6px 12px',
    borderRadius: 6,
    fontSize: '0.85rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  dropdownBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.4rem',
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #9ece6a',
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    fontSize: '0.85rem',
    cursor: 'pointer',
    textAlign: 'left' as const,
    boxSizing: 'border-box' as const,
  },
  dropdownBtnText: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: 'var(--text-secondary)',
  },
  dropdownList: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    right: 0,
    background: '#1a1b26',
    border: '1px solid #292e42',
    borderRadius: 8,
    padding: '0.3rem 0',
    zIndex: 300,
    maxHeight: 220,
    overflowY: 'auto' as const,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    marginTop: 2,
  },
  dropdownItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.3rem 0.75rem',
    fontSize: '0.82rem',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  fieldGroup: {
    marginBottom: '0.75rem',
  },
  fieldRow: {
    display: 'flex',
    gap: '1rem',
    marginBottom: 0,
  },
  label: {
    display: 'block',
    color: 'var(--text-secondary)',
    fontSize: '0.8rem',
    marginBottom: '0.25rem',
    fontWeight: 600,
  },
  checkRow: {
    display: 'flex',
    gap: '1.5rem',
    marginBottom: '0.75rem',
  },
  groupSelector: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    maxHeight: 150,
    overflowY: 'auto' as const,
    padding: '0.5rem',
    background: 'var(--bg-base)',
    borderRadius: 6,
    border: '1px solid var(--border)',
  },
  groupChip: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: '0.78rem',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
  },
  overlay: {
    position: 'fixed' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '1.5rem',
    minWidth: 380,
    maxWidth: 500,
  },
  modalTitle: {
    margin: '0 0 1rem 0',
    color: 'var(--text-primary)',
    fontSize: '1.05rem',
  },
  modalText: {
    color: 'var(--text-secondary)',
    fontSize: '0.85rem',
    margin: '0 0 1rem 0',
  },
  modalInput: {
    width: '100%',
    background: 'var(--bg-base)',
    border: '1px solid #9ece6a',
    color: 'var(--text-primary)',
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: '0.9rem',
    marginBottom: '1rem',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  modalActions: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'flex-end',
  },
};
