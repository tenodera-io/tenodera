import { useEffect, useRef } from 'react';
import { useTransport } from '../api/HostTransportContext.tsx';
import { type Message } from '../api/transport.ts';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Interactive shell into a running container (`<rt> exec -it <id> <shell>`),
// via the terminal.pty channel with a `container` option. Superuser-gated.
export function ContainerExec({ container, label, password, shell, onClose }: {
  container: string;
  label: string;
  password: string;
  shell?: string;
  onClose: () => void;
}) {
  const { openChannel } = useTransport();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: 'var(--bg-app)', foreground: 'var(--text-1)', cursor: 'var(--text-1)',
        selectionBackground: 'color-mix(in srgb, var(--c-blue) 30%, var(--bg-app))',
        red: 'var(--c-red)', green: 'var(--c-green)', yellow: 'var(--c-yellow)',
        blue: 'var(--c-blue)', magenta: 'var(--c-purple)', cyan: 'var(--c-cyan)', white: 'var(--text-2)',
      },
      scrollback: 10000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();

    const ch = openChannel('terminal.pty', { container, password, cols: term.cols, rows: term.rows, ...(shell ? { shell } : {}) });

    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const d = msg.data as { output?: string };
        if (d.output) term.write(d.output);
      }
      if (msg.type === 'close') {
        const problem = (msg as { problem?: string }).problem;
        term.write(`\r\n\x1b[31m[Session ended${problem ? `: ${problem}` : ''}]\x1b[0m\r\n`);
      }
    });
    term.onData((data: string) => ch.send({ input: data }));
    term.onResize(({ cols, rows }) => ch.send({ resize: { cols, rows } }));

    const doFit = () => fit.fit();
    window.addEventListener('resize', doFit);
    const ro = new ResizeObserver(doFit);
    ro.observe(ref.current);
    const t = setTimeout(doFit, 60);
    term.focus();

    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', doFit);
      ro.disconnect();
      ch.close();
      term.dispose();
    };
  }, [openChannel, container, password, shell]);

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.bar}>
          <span style={dot('var(--c-red)')} /><span style={dot('var(--c-yellow)')} /><span style={dot('var(--c-green)')} />
          <span style={S.title}>exec — {label}{shell ? ` (${shell})` : ''}</span>
          <span style={{ flex: 1 }} />
          <button style={S.close} onClick={onClose} title="Close">✕</button>
        </div>
        <div ref={ref} style={S.term} />
      </div>
    </div>
  );
}

function dot(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' };
}

const S: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: '1.5rem' },
  modal: { width: '100%', maxWidth: 1000, height: '72vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)', border: '1px solid var(--border-1)', borderRadius: 10, overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' },
  bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-1)', flexShrink: 0 },
  title: { color: 'var(--text-3)', fontSize: '0.75rem', marginLeft: 6, fontFamily: 'monospace' },
  close: { border: 'none', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: '0.9rem' },
  term: { flex: 1, minHeight: 0, background: 'var(--bg-app)', padding: '4px' },
};
