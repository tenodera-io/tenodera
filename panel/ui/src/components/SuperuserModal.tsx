interface Props {
  suPwInput: string;
  suError: string;
  onPwChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}

export function SuperuserModal({ suPwInput, suError, onPwChange, onSubmit, onClose }: Props) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <form style={S.modal} onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <h3 style={S.title}>🔓 Switch to Administrative Access</h3>
        <p style={S.desc}>
          Enter your password to enable superuser privileges. Actions like
          managing services and containers will use sudo automatically.
        </p>
        {suError && <div style={S.error}>{suError}</div>}
        <input
          type="password"
          placeholder="Password"
          value={suPwInput}
          onChange={(e) => onPwChange(e.target.value)}
          style={{ ...S.input, borderColor: suPwInput ? '#7aa2f7' : '#9ece6a' }}
          autoFocus
          autoComplete="current-password"
        />
        <div style={S.actions}>
          <button type="button" onClick={onClose} style={S.cancelBtn}>Cancel</button>
          <button type="submit" style={S.submitBtn}>Authenticate</button>
        </div>
      </form>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 500,
  },
  modal: {
    background: '#1a1b26', border: '1px solid #292e42', borderRadius: 10,
    padding: '1.5rem', width: '100%', maxWidth: 400,
  },
  title: { fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' },
  desc: { fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 },
  error: { color: '#f7768e', fontSize: '0.82rem', marginBottom: '0.5rem' },
  input: {
    width: '100%', padding: '0.6rem', borderRadius: 4,
    border: '1px solid #9ece6a', background: 'var(--bg-primary)',
    color: 'var(--text-primary)', fontSize: '0.9rem', marginBottom: '1rem',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' },
  cancelBtn: {
    padding: '0.4rem 0.9rem', borderRadius: 4, border: '1px solid var(--border)',
    background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.82rem',
  },
  submitBtn: {
    padding: '0.4rem 0.9rem', borderRadius: 4, border: 'none',
    background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem',
  },
};
