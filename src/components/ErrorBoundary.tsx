import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { error: Error | null };

/** A render error in one component must not blank the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong in the window.</h2>
        <p>Your agents, routines and data are safe. Reload the window to continue.</p>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#c0392b', fontSize: 12 }}>{this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload window
        </button>
      </div>
    );
  }
}
