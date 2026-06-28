import { cn } from '../../lib/utils'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'

/** A single selectable option in the segmented control. */
export interface SegmentedControlOption {
  readonly value: string
  readonly label: string
}

interface SegmentedControlProps {
  /** The currently-selected option value. */
  readonly value: string
  /** Called with the option value when the user picks a new option. */
  readonly onChange: (value: string) => void
  /** The full set of selectable options, rendered as buttons in order. */
  readonly options: ReadonlyArray<SegmentedControlOption>
  /** Required accessible label describing what this control selects. */
  readonly 'aria-label': string
  /** Optional extra classes appended to the group container. */
  readonly className?: string
}

const GROUP_CLS =
  'inline-flex items-center gap-1 rounded-md border border-surface-1 bg-surface-0/40 p-1'

const ITEM_BASE =
  'inline-flex min-h-[36px] items-center justify-center rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-[28px]'

const ITEM_ACTIVE =
  'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90'

const ITEM_INACTIVE =
  'border border-transparent text-muted-foreground hover:bg-surface-0/60 hover:text-foreground data-[state=off]:bg-transparent'

/**
 * Toggle-group primitive for picking one of N short options.
 *
 * Wraps Radix ToggleGroup (`type="single"`) behind the same public API as the
 * old hand-rolled radiogroup component. Keyboard navigation (ArrowRight/Left
 * with wrap) is handled by Radix's roving-tabindex implementation.
 *
 * Mandatory-selection invariant: Radix single-select emits an empty string
 * when the user clicks the active item to deselect it. This guard drops those
 * empty values so `onChange` only fires with a real option value, preserving
 * the old radiogroup behavior where one item is always selected.
 */
export function SegmentedControl({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps) {
  const handleValueChange = (next: string) => {
    // Guard: Radix emits '' when the user clicks the already-active item.
    // Drop empty values — selection is mandatory.
    if (next) onChange(next)
  }

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={handleValueChange}
      aria-label={ariaLabel}
      className={cn(GROUP_CLS, className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.label}
          className={cn(ITEM_BASE, ITEM_ACTIVE, ITEM_INACTIVE)}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
