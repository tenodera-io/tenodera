// Calm, non-error banner shown when a privileged read was brokered to the logged-in
// user and the host's own permissions limited what they can see. This is expected,
// not a failure — the panel never escalates for reads, so the host decides.
import { Icon } from './Icons.tsx';

interface RestrictedNoticeProps {
  /** `reason` from the agent's restricted result, e.g. "no-account". */
  reason?: string;
  /** What is being restricted, for the message, e.g. "the system journal". */
  what?: string;
}

export function RestrictedNotice({ reason, what = 'this data' }: RestrictedNoticeProps) {
  const message =
    reason === 'no-account'
      ? `Your account isn't present on this host, so ${what} isn't visible to you. Only baseline, non-sensitive information is shown.`
      : `You're seeing only what your own session on this host can access. To view all of ${what}, you need membership in the host's adm/systemd-journal group — or enable superuser mode if your account may use sudo here.`;

  return (
    <div style={styles.box}>
      <span style={styles.icon}><Icon name="shield" size={18} /></span>
      <div>
        <div style={styles.title}>Limited by host permissions</div>
        <p style={styles.body}>{message}</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    display: 'flex',
    gap: '0.6rem',
    alignItems: 'flex-start',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border)',
    borderLeft: '3px solid var(--c-orange)',
    borderRadius: '8px',
    padding: '0.7rem 0.9rem',
    margin: '0.5rem 0',
  },
  icon: {
    color: 'var(--c-orange)',
    flexShrink: 0,
    marginTop: '1px',
  },
  title: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: 'var(--text-1)',
  },
  body: {
    fontSize: '0.8rem',
    color: 'var(--text-2)',
    margin: '0.2rem 0 0',
    lineHeight: 1.4,
  },
};
