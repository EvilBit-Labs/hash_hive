import { cn } from '../../lib/utils'

export type AgentFilter = 'all' | 'online' | 'offline' | 'error'

interface AgentFilterButtonsProps {
  value: AgentFilter
  onChange: (next: AgentFilter) => void
}

const FILTERS: { value: AgentFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'error', label: 'Error' },
]

export function AgentFilterButtons({ value, onChange }: AgentFilterButtonsProps) {
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a div with role="group" preserves inline flex layout; fieldset adds default block styling that breaks the segmented control look
      role="group"
      aria-label="Filter agents by status"
      className="inline-flex items-center gap-1 rounded-md border border-surface-0 bg-surface-0/30 p-1"
    >
      {FILTERS.map((filter) => {
        const isActive = filter.value === value
        return (
          <button
            key={filter.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(filter.value)}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'bg-surface-1 text-foreground'
                : 'text-muted-foreground hover:bg-surface-0/60 hover:text-foreground'
            )}
          >
            {filter.label}
          </button>
        )
      })}
    </div>
  )
}
