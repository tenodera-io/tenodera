import { useEffect, useRef, useCallback } from 'react';
import { type Message } from '../api/transport.ts';
import { useTransport } from '../api/HostTransportContext.tsx';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  user: string;
}

export function Terminal({ user }: TerminalProps) {
  const { openChannel } = useTransport();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);

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
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      <h2 style={{ margin: '0 0 0.5rem 0' }}>Terminal</h2>
      <div
        ref={containerRef}
        style={{
          background: '#1a1b26',
          borderRadius: '8px',
          padding: '4px',
          flex: 1,
          minHeight: 0,
        }}
      />
    </div>
  );
}
