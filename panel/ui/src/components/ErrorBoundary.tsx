import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] uncaught render error', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div style={{
        padding: '2rem',
        color: 'var(--c-red)',
        fontFamily: 'monospace',
        fontSize: '0.9rem',
      }}>
        <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>Something went wrong</div>
        <div style={{ color: 'var(--text-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {this.state.error?.message}
        </div>
        <button
          onClick={() => this.setState({ hasError: false, error: null })}
          style={{
            marginTop: '1rem',
            padding: '0.4rem 0.9rem',
            borderRadius: 4,
            border: '1px solid color-mix(in srgb, var(--c-red) 27%, transparent)',
            background: 'color-mix(in srgb, var(--c-red) 13%, transparent)',
            color: 'var(--c-red)',
            cursor: 'pointer',
            fontSize: '0.82rem',
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
