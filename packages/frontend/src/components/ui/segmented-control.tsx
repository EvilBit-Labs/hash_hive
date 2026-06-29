import type { KeyboardEvent } from 'react'

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
 * Picks one of N short options, rendered as segmented buttons.
 *
 * Wraps Radix ToggleGroup (`type="single"`, `loop`) behind the same public API
 * as the old hand-rolled radiogroup. Orientation is left unset, so Radix's
 * roving-tabindex moves focus on all four arrow keys (with wrap); a
 * capture-phase keydown handler commits the selection for the same four keys,
 * so arrows move BOTH focus and selection — the WAI-ARIA radio pattern the
 * original implemented, which Radix ToggleGroup's roving does not provide on
 * its own. Capture phase runs before Radix's item handlers, and Radix moves
 * focus to the same item we select, so the two stay aligned.
 *
 * Mandatory-selection invariant: Radix single-select emits an empty string when
 * the user clicks the active item to deselect it. The `onValueChange` guard
 * drops those empty values so one item is always selected.
 */
export function SegmentedControl({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps) {
  const handleValueChange = (next: string) => {
    // Radix emits '' when the active item is clicked to deselect — drop it.
    if (next) onChange(next)
  }

  const handleArrowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const isNext = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const isPrev = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (!isNext && !isPrev) return
    // Do NOT preventDefault here. Radix's RovingFocusGroup moves focus and
    // already suppresses the arrow's default scroll, but its item handler is
    // composed with checkForDefaultPrevented — so calling preventDefault in
    // this capture-phase handler would make Radix skip the focus move, leaving
    // selection and focus out of sync.
    const currentIndex = options.findIndex((option) => option.value === value)
    if (currentIndex === -1) {
      if (import.meta.env.DEV) {
        // oxlint-disable-next-line no-console
        console.warn(`SegmentedControl: value "${value}" does not match any option`)
      }
      return
    }
    const delta = isNext ? 1 : -1
    const next = options[(currentIndex + delta + options.length) % options.length]
    if (next) onChange(next.value)
  }

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={handleValueChange}
      aria-label={ariaLabel}
      loop
      onKeyDownCapture={handleArrowKeys}
      className={cn(GROUP_CLS, className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={cn(ITEM_BASE, ITEM_ACTIVE, ITEM_INACTIVE)}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
