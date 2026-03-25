import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login.tsx';
import { Shell } from './pages/Shell.tsx';
import { logout as apiLogout } from './api/auth.ts';

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
    </BrowserRouter>
  );
}
