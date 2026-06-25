import { useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { logout as apiLogout, UserRole } from './api/auth.ts';

const Login = lazy(() => import('./pages/Login.tsx').then(m => ({ default: m.Login })));
const Shell = lazy(() => import('./pages/Shell.tsx').then(m => ({ default: m.Shell })));

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem('session_id'),
  );
  const [user, setUser] = useState<string>(
    () => sessionStorage.getItem('user') || '',
  );
  const [role, setRole] = useState<UserRole>(
    () => (sessionStorage.getItem('role') as UserRole) || 'readonly',
  );

  const handleLogin = (id: string, username: string, userRole: UserRole) => {
    sessionStorage.setItem('session_id', id);
    sessionStorage.setItem('user', username);
    sessionStorage.setItem('role', userRole);
    setSessionId(id);
    setUser(username);
    setRole(userRole);
  };

  const handleLogout = () => {
    const sid = sessionStorage.getItem('session_id');
    if (sid) apiLogout(sid);
    sessionStorage.removeItem('session_id');
    sessionStorage.removeItem('user');
    sessionStorage.removeItem('role');
    setSessionId(null);
    setUser('');
    setRole('readonly');
  };

  return (
    <BrowserRouter>
      <Suspense fallback={null}>
        <Routes>
          <Route
            path="/login"
            element={
              sessionId ? <Navigate to="/" /> : <Login onLogin={handleLogin} />
            }
          />
          <Route
            path="/*"
            element={
              sessionId ? (
                <Shell sessionId={sessionId} user={user} role={role} onLogout={handleLogout} />
              ) : (
                <Navigate to="/login" />
              )
            }
          />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
