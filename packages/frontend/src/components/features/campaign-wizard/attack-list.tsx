import type { AttackConfig } from '../../../stores/campaign-wizard'

import { attackModeLabel } from '../../../lib/attack-modes'
import { cn } from '../../../lib/utils'

interface AttackListProps {
  attacks: readonly AttackConfig[]
  editingIndex: number | null
  onEdit: (idx: number) => void
  onRemove: (idx: number) => void
}

/**
 * Read-only summary of attacks that have been added to the wizard so far,
 * with Edit and Remove affordances per row. Wizard indices have no stable
 * ID before backend creation, so `key={i}` is the only choice.
 */
export function AttackList({ attacks, editingIndex, onEdit, onRemove }: AttackListProps) {
  if (attacks.length === 0) return null

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Configured Attacks</h3>
      {attacks.map((attack, i) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- attacks have no stable ID before creation
          key={i}
          className="border-surface-0 bg-surface-0/30 flex items-center justify-between rounded-md border p-3"
        >
          <div className="text-xs">
            <span className="font-mono font-medium">
              #{i} {attackModeLabel(attack.mode)}
            </span>
            {attack.wordlistId && (
              <span className="text-muted-foreground ml-2">Wordlist #{attack.wordlistId}</span>
            )}
            {attack.rulelistId && (
              <span className="text-muted-foreground ml-2">Rulelist #{attack.rulelistId}</span>
            )}
            {attack.dependencies.length > 0 && (
              <span className="text-muted-foreground ml-2">
                Deps: [{attack.dependencies.join(', ')}]
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onEdit(i)}
              className={cn(
                'hover:text-foreground text-xs',
                editingIndex === i ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {editingIndex === i ? 'Editing...' : 'Edit'}
            </button>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="text-destructive hover:text-destructive/80 text-xs"
            >
              Remove
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
