import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  readonly fallback: (error: Error, retry: () => void) => ReactNode;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/** Keeps a render error inside one part of the window instead of unmounting the whole app. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    return this.state.error
      ? this.props.fallback(this.state.error, () => this.setState({ error: null }))
      : this.props.children;
  }
}
