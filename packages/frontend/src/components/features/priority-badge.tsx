import { CAMPAIGN_PRIORITY, type CampaignPriorityBucket, priorityBucket } from '@hashhive/shared'

import { cn } from '../../lib/utils'

// Re-export so existing test imports (`import { priorityBucket } from
// '.../priority-badge'`) keep working without touching every call site.
export { priorityBucket } from '@hashhive/shared'

/**
 * Maps the backend's integer priority convention into a human-readable
 * label and color token. Backend uses 1/5/10 as canonical buckets via
 * `priorityMap` in `services/campaigns.ts`. Any other integer is shown
 * with the `normal` bucket's styling but labelled with the raw value
 * (e.g., `priority 3`) so the operator can tell custom values apart
 * from real `normal` rows.
 */

interface PriorityBadgeProps {
  priority: number
  className?: string
}

const BUCKET_STYLES: Record<CampaignPriorityBucket, string> = {
  high: 'bg-destructive/15 text-destructive border-destructive/20',
  normal: 'bg-info/15 text-info border-info/20',
  low: 'bg-surface-1/50 text-muted-foreground border-surface-1',
}

function isCanonicalPriority(priority: number): boolean {
  return (
    priority === CAMPAIGN_PRIORITY.HIGH ||
    priority === CAMPAIGN_PRIORITY.NORMAL ||
    priority === CAMPAIGN_PRIORITY.LOW
  )
}

export function PriorityBadge({ priority, className }: PriorityBadgeProps) {
  const bucket = priorityBucket(priority)
  const label = isCanonicalPriority(priority) ? bucket : `priority ${priority}`
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        BUCKET_STYLES[bucket],
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current')} />
      {label}
    </span>
  )
}
