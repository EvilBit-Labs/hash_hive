import { cn } from '../../lib/utils'

const WARNING_STYLES = 'bg-warning/15 text-warning border-warning/20'
const FATAL_STYLES = 'bg-destructive/15 text-destructive border-destructive/20'
const NEUTRAL_STYLES = 'bg-surface-1/50 text-muted-foreground border-surface-1'

// Severity tiers mirror the backend policy in
// packages/backend/src/services/agents.ts. Anything outside these sets
// (info/debug/notice/...) is informational and uses the neutral style so it
// doesn't visually masquerade as a fatal error.
const FATAL_SEVERITIES = new Set(['fatal', 'critical', 'error'])
const WARNING_SEVERITIES = new Set(['warning'])

interface SeverityBadgeProps {
  severity: string
  className?: string
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const lower = severity.toLowerCase()
  const tone = FATAL_SEVERITIES.has(lower)
    ? FATAL_STYLES
    : WARNING_SEVERITIES.has(lower)
      ? WARNING_STYLES
      : NEUTRAL_STYLES
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        tone,
        className
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {severity}
    </span>
  )
}
