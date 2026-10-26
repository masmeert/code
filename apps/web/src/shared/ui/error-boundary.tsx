import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  readonly fallback: (error: Error, retry: () => void) => ReactNode;
  /** A change clears the error, e.g. switching to another view gives that one a fresh try. */
  readonly resetKey?: unknown;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  readonly resetKey: unknown;
}

/** Keeps a render error inside one part of the window instead of unmounting the whole app. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState) {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    return this.state.error
      ? this.props.fallback(this.state.error, () => this.setState({ error: null }))
      : this.props.children;
  }
}
