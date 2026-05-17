import { cn } from '../../lib/utils';

/**
 * Maps the backend's integer priority convention into a human-readable
 * label and color token. The backend pegs three canonical values per
 * `priorityMap` in `services/campaigns.ts`:
 *   1  -> high   (destructive)
 *   5  -> normal (info)
 *   10 -> low    (muted)
 * Any other integer falls back to `normal` styling — values outside
 * { 1, 5, 10 } are rejected at the list filter boundary but can still
 * appear on existing rows when a custom priority was set before the
 * convention was enforced.
 */

type PriorityBucket = 'high' | 'normal' | 'low';

interface PriorityBadgeProps {
  priority: number;
  className?: string;
}

const BUCKET_FROM_PRIORITY: Record<number, PriorityBucket> = {
  1: 'high',
  5: 'normal',
  10: 'low',
};

const BUCKET_STYLES: Record<PriorityBucket, string> = {
  high: 'bg-destructive/15 text-destructive border-destructive/20',
  normal: 'bg-info/15 text-info border-info/20',
  low: 'bg-surface-1/50 text-muted-foreground border-surface-1',
};

export function priorityBucket(priority: number): PriorityBucket {
  return BUCKET_FROM_PRIORITY[priority] ?? 'normal';
}

export function PriorityBadge({ priority, className }: PriorityBadgeProps) {
  const bucket = priorityBucket(priority);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        BUCKET_STYLES[bucket],
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current')} />
      {bucket}
    </span>
  );
}
