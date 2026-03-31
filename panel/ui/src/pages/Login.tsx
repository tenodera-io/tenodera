import { useState } from 'react';
import { login } from '../api/auth.ts';

interface LoginProps {
  onLogin: (sessionId: string, user: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tried, setTried] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!user || !password) return;
    setError('');
    setLoading(true);

    try {
      const result = await login(user, password);
      setPassword('');
      onLogin(result.session_id, result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <form onSubmit={handleSubmit} style={styles.form} action="#">
        <img src="/tenodera.webp" alt="Tenodera" style={styles.loginLogo} />
        <p style={styles.subtitle}>System Administration</p>

        {error && <div style={styles.error}>{error}</div>}

        <input
          type="text"
          placeholder="Username"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          style={{ ...styles.input, borderColor: tried && !user ? '#f7768e' : user ? '#7aa2f7' : '#9ece6a' }}
          autoFocus
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ ...styles.input, borderColor: tried && !password ? '#f7768e' : password ? '#7aa2f7' : '#9ece6a' }}
          autoComplete="current-password"
        />
        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? 'Logging in...' : 'Log In'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    padding: '2rem',
    background: 'var(--bg-secondary)',
    borderRadius: '8px',
    width: '100%',
    maxWidth: '360px',
  },
  loginLogo: {
    display: 'block',
    margin: '-0.5rem auto 0',
    width: '220px',
    height: 'auto',
  },
  subtitle: {
    textAlign: 'center' as const,
    color: 'var(--text-secondary)',
    fontSize: '0.875rem',
  },
  input: {
    padding: '0.75rem',
    borderRadius: '4px',
    border: '1px solid #9ece6a',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '1rem',
  },
  button: {
    padding: '0.75rem',
    borderRadius: '4px',
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    color: '#ff6b6b',
    textAlign: 'center' as const,
    fontSize: '0.875rem',
  },
};
