import type { AgentWorstSeverity } from '../../hooks/use-dashboard';
import { cn } from '../../lib/utils';

interface AgentErrorBadgeProps {
  count: number;
  severity: AgentWorstSeverity;
  agentId: number;
  onActivate?: (agentId: number) => void;
}

export function AgentErrorBadge({ count, severity, agentId, onActivate }: AgentErrorBadgeProps) {
  if (count <= 0 || !severity) {
    return null;
  }

  const isFatal = severity === 'fatal';
  const styles = isFatal
    ? 'bg-destructive/15 text-destructive border-destructive/30 hover:bg-destructive/25'
    : 'bg-warning/15 text-warning border-warning/30 hover:bg-warning/25';
  const label = `${count} ${count === 1 ? 'error' : 'errors'} in last 24h`;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onActivate?.(agentId);
      }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors',
        styles
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {count}
    </button>
  );
}
