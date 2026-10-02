import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorText } from '../shared/ui.tsx';

/** Shows a page's error instead of a blank screen; it is reset when the wallet data changes. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: number }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {}

  override componentDidUpdate(previous: { resetKey: number }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="card" role="alert">
        <h2>Something went wrong on this page</h2>
        <p>{errorText(this.state.error)}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
