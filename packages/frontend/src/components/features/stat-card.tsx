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
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 text-3xl font-bold">{loading ? '--' : value}</p>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </>
  );

  if (to) {
    return (
      <button
        type="button"
        onClick={() => navigate(to)}
        className="w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        {content}
      </button>
    );
  }

  return <div className="rounded-lg border bg-card p-4">{content}</div>;
}
