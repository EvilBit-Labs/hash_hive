import { useNavigate } from 'react-router';
import { cn } from '../../lib/utils';

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle: string;
  loading?: boolean;
  /** SPA route to navigate to when clicked. Omit for non-interactive card. */
  to?: string;
  /** CSS custom property name for the left-border accent (e.g. "--ctp-teal"). */
  accent?: string;
}

export function StatCard({ title, value, subtitle, loading, to, accent }: StatCardProps) {
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

  const accentStyle = accent ? { borderLeftColor: `hsl(var(${accent}))` } : undefined;

  if (to) {
    return (
      <button
        type="button"
        onClick={() => navigate(to)}
        style={accentStyle}
        className={cn(
          'group w-full rounded-md border bg-surface-0/40 p-4 text-left transition-all',
          accent ? 'border-l-2 border-surface-0' : 'border-surface-0',
          'hover:border-primary/30 hover:bg-surface-0/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      style={accentStyle}
      className={cn(
        'rounded-md border bg-surface-0/40 p-4',
        accent ? 'border-l-2 border-surface-0' : 'border-surface-0'
      )}
    >
      {content}
    </div>
  );
}
