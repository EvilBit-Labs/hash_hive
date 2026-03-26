import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // biome-ignore lint/suspicious/noConsole: error boundary logging is intentional
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-crust">
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-surface-0/50 bg-mantle p-8 text-center">
            <p className="font-mono text-4xl font-bold text-surface-2">!</p>
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <ErrorBanner message="An unexpected error occurred. Please try again." />
            <Button
              onClick={() => {
                this.setState({ hasError: false });
                window.location.href = '/';
              }}
            >
              Return to Dashboard
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
