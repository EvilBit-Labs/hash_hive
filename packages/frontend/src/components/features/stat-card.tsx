import { useNavigate } from 'react-router';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle: string;
  loading?: boolean;
  /** SPA route to navigate to when clicked. Omit for non-interactive card. */
  to?: string;
}

export function StatCard({ title, value, subtitle, loading, to }: StatCardProps) {
  const navigate = useNavigate();

  const content = (
    <>
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-foreground">
        {loading ? '-' : value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
    </>
  );

  if (to) {
    return (
      <button
        type="button"
        onClick={() => navigate(to)}
        className="group w-full rounded-md border border-surface-0 bg-surface-0/40 p-4 text-left transition-all hover:border-primary/30 hover:bg-surface-0/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {content}
      </button>
    );
  }

  return <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">{content}</div>;
}
