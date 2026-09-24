import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    void error;
    void info;
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            minHeight: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'var(--bg)',
            color: 'var(--text)'
          }}
        >
          <div className="card" style={{ maxWidth: 560, width: '100%' }}>
            <h2 style={{ marginTop: 0, color: 'var(--red)' }}>Something went wrong</h2>
            <p className="muted" style={{ marginBottom: 10 }}>
              Project Hub hit a rendering error and paused the UI to avoid a blank screen. Reload to continue — your data is safe.
            </p>
            <pre className="content-block" style={{ marginBottom: 14 }}>
              {this.state.error.message || String(this.state.error)}
            </pre>
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload Project Hub
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}