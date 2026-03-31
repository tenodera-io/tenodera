import { useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { logout as apiLogout } from './api/auth.ts';

const Login = lazy(() => import('./pages/Login.tsx').then(m => ({ default: m.Login })));
const Shell = lazy(() => import('./pages/Shell.tsx').then(m => ({ default: m.Shell })));

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    () => sessionStorage.getItem('session_id'),
  );
  const [user, setUser] = useState<string>(
    () => sessionStorage.getItem('user') || '',
  );

  const handleLogin = (id: string, username: string) => {
    sessionStorage.setItem('session_id', id);
    sessionStorage.setItem('user', username);
    setSessionId(id);
    setUser(username);
  };

  const handleLogout = () => {
    const sid = sessionStorage.getItem('session_id');
    if (sid) apiLogout(sid);
    sessionStorage.removeItem('session_id');
    sessionStorage.removeItem('user');
    setSessionId(null);
    setUser('');
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
                <Shell sessionId={sessionId} user={user} onLogout={handleLogout} />
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
