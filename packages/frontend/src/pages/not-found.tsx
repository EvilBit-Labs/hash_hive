import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center space-y-4">
      <p className="font-mono text-6xl font-bold text-surface-2">404</p>
      <p className="text-sm text-muted-foreground">Page not found</p>
      <Link
        to="/"
        className="rounded bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
