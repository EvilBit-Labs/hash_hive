import { cn } from '../../lib/utils';

const WARNING_STYLES = 'bg-warning/15 text-warning border-warning/20';
const FATAL_STYLES = 'bg-destructive/15 text-destructive border-destructive/20';

interface SeverityBadgeProps {
  severity: string;
  className?: string;
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const isWarning = severity.toLowerCase() === 'warning';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        isWarning ? WARNING_STYLES : FATAL_STYLES,
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {severity}
    </span>
  );
}
