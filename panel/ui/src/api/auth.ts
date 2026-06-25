const API_BASE = '/api';

export type UserRole = 'admin' | 'readonly';

export interface LoginResponse {
  session_id: string;
  user: string;
  role: UserRole;
}

export async function login(user: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Login failed (${res.status})`);
  }

  return res.json();
}

export async function logout(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionId}`,
    },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});
}
