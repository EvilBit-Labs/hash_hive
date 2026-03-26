import { cn } from '../../lib/utils';

const STATUS_STYLES: Record<string, string> = {
  online: 'bg-success/15 text-success border-success/20',
  offline: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  busy: 'bg-warning/15 text-warning border-warning/20',
  error: 'bg-destructive/15 text-destructive border-destructive/20',
  running: 'bg-info/15 text-info border-info/20',
  paused: 'bg-warning/15 text-warning border-warning/20',
  completed: 'bg-success/15 text-success border-success/20',
  cancelled: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  pending: 'bg-surface-1/50 text-muted-foreground border-surface-1',
  failed: 'bg-destructive/15 text-destructive border-destructive/20',
  draft: 'bg-ctp-mauve/15 text-ctp-mauve border-ctp-mauve/20',
};

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const styles = STATUS_STYLES[status] ?? STATUS_STYLES['pending'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
        styles
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'running' && 'animate-pulse-gentle',
          // Dot inherits text color via currentColor
          'bg-current'
        )}
      />
      {status}
    </span>
  );
}
