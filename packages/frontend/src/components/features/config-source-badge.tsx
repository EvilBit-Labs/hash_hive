import type { ConfigValueSource } from '@hashhive/shared'

import { cn } from '../../lib/utils'

interface ConfigSourceBadgeProps {
  readonly source: ConfigValueSource
  readonly className?: string
}

const SOURCE_LABELS: Record<ConfigValueSource, string> = {
  override: 'overridden',
  fleet: 'inherited',
  engine: 'engine default',
}

const SOURCE_CLASSES: Record<ConfigValueSource, string> = {
  override: 'bg-primary/10 text-primary border-primary/20',
  fleet: 'bg-surface-0/60 text-muted-foreground border-surface-1',
  engine: 'bg-surface-0/30 text-muted-foreground/70 border-surface-0',
}

export function ConfigSourceBadge({ source, className }: ConfigSourceBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium',
        SOURCE_CLASSES[source],
        className
      )}
      aria-label={`Source: ${SOURCE_LABELS[source]}`}
    >
      {SOURCE_LABELS[source]}
    </span>
  )
}
