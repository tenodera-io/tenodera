import { useEffect, useRef, useCallback, useState } from 'react';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  user: string;
  hostname?: string;
}

export function Terminal({ user, hostname }: TerminalProps) {
  const { openChannel } = useTransport();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const [copied, setCopied] = useState(false);

  const initTerminal = useCallback(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
      },
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const cols = term.cols;
    const rows = term.rows;

    xtermRef.current = term;

    // Auto-copy selection to clipboard
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel) return;
      // Try modern Clipboard API first (requires HTTPS or localhost)
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(sel).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {
          fallbackCopy(sel);
        });
      } else {
        fallbackCopy(sel);
      }
    });

    function fallbackCopy(text: string) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (_e) { /* silent */ }
      document.body.removeChild(ta);
    }

    // Open PTY channel with home directory
    const homeDir = user ? `/home/${user}` : '/tmp';
    const ch = openChannel('terminal.pty', {
      cols,
      rows,
      cwd: homeDir,
    });

    // PTY output → xterm
    ch.onMessage((msg: Message) => {
      if (msg.type === 'data' && 'data' in msg) {
        const data = msg.data as { output?: string };
        if (data.output) {
          term.write(data.output);
        }
      }
      if (msg.type === 'close') {
        term.write('\r\n\x1b[31m[Session ended]\x1b[0m\r\n');
      }
    });

    // Keyboard input → PTY
    term.onData((data: string) => {
      ch.send({ input: data });
    });

    // Send resize to PTY backend when terminal dimensions change
    term.onResize(({ cols, rows }) => {
      ch.send({ resize: { cols, rows } });
    });

    // Handle resize — fit terminal to container
    const doFit = () => { fitAddon.fit(); };
    window.addEventListener('resize', doFit);

    // Also observe the container itself for size changes (e.g. sidebar toggle)
    let ro: ResizeObserver | undefined;
    if (containerRef.current) {
      ro = new ResizeObserver(doFit);
      ro.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', doFit);
      ro?.disconnect();
      ch.close();
      term.dispose();
      xtermRef.current = null;
    };
  }, [user, openChannel]);

  useEffect(() => {
    const cleanup = initTerminal();
    return cleanup;
  }, [initTerminal]);

  return (
    <div style={S.page}>
      <h2 style={S.title}>Terminal</h2>
      <div style={copied ? { ...S.hint, ...S.hintCopied } : S.hint}>
        {copied ? 'Copied to clipboard' : 'Ctrl+Shift+C is reserved by the browser \u2014 text is copied automatically when selected'}
      </div>
      <div style={S.termBorder}>
        <div style={S.termTitleBar}>
        <span style={dotStyle('#f7768e')} />
        <span style={dotStyle('#e0af68')} />
        <span style={dotStyle('#9ece6a')} />
          <span style={S.termTitleText}>Tenodera — {user}@{hostname || 'local'}</span>
        </div>
        <div ref={containerRef} style={S.termContainer} />
      </div>
    </div>
  );
}

/* ── styles ─────────────────────────────────────────────── */

function dotStyle(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block' };
}

const S: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: 'calc(100vh - 120px)',
    padding: '0.5rem 0',
  },
  title: {
    margin: 0,
    fontSize: '1.4rem',
    color: 'var(--text-primary)',
  },
  hint: {
    color: '#e0af68',
    fontSize: '0.82rem',
    margin: '0.25rem 0 0.5rem 0',
    transition: 'color 0.3s',
  },
  hintCopied: {
    color: '#9ece6a',
  },
  termBorder: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #414868',
    borderRadius: 10,
    overflow: 'hidden',
    boxShadow: '0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(122,162,247,0.1)',
  },
  termTitleBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    background: '#1e1f2e',
    borderBottom: '1px solid #2a2b3d',
    flexShrink: 0,
  },
  termTitleText: {
    color: '#565f89',
    fontSize: '0.75rem',
    marginLeft: '6px',
    fontFamily: 'monospace',
  },
  termContainer: {
    background: '#1a1b26',
    padding: '4px',
    flex: 1,
    minHeight: 0,
  },
};
