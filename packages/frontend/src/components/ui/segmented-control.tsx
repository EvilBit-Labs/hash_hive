import { type KeyboardEvent, useCallback, useRef } from 'react'

import { cn } from '../../lib/utils'

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

const BUTTON_BASE =
  'inline-flex min-h-[36px] items-center justify-center rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-[28px]'

const BUTTON_ACTIVE = 'bg-primary text-primary-foreground hover:bg-primary/90'

const BUTTON_INACTIVE =
  'border border-transparent text-muted-foreground hover:bg-surface-0/60 hover:text-foreground'

/**
 * Toggle-group primitive for picking one of N short options.
 *
 * Visually a flat row of buttons; the active button gets a filled
 * primary treatment, the inactive buttons read as outlined. Component-local
 * state — the parent owns `value` / `onChange`.
 *
 * Keyboard: each button sits in the normal tab order; once focused, left/right
 * arrows move focus AND selection to the adjacent option, wrapping at both
 * ends. The behavior mirrors the WAI-ARIA radiogroup pattern (mutually
 * exclusive selection; arrows move both focus and selection in one step)
 * rather than the toolbar pattern (which would move focus only). The
 * surrounding markup uses `role="group"` with `aria-pressed` on each
 * button so each option is independently labeled.
 */
export function SegmentedControl({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([])

  const moveTo = useCallback(
    (nextIndex: number) => {
      const next = options[nextIndex]
      if (!next) return
      onChange(next.value)
      const node = buttonRefs.current[nextIndex]
      if (node) node.focus()
    },
    [onChange, options]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const total = options.length
      if (total === 0) return
      const delta = event.key === 'ArrowRight' ? 1 : -1
      const nextIndex = (index + delta + total) % total
      moveTo(nextIndex)
    },
    [moveTo, options.length]
  )

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a div with role="group" preserves inline flex layout; fieldset adds default block styling that breaks the segmented control look
      role="group"
      aria-label={ariaLabel}
      className={cn(GROUP_CLS, className)}
    >
      {options.map((option, index) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttonRefs.current[index] = node
            }}
            type="button"
            aria-pressed={isActive}
            className={cn(BUTTON_BASE, isActive ? BUTTON_ACTIVE : BUTTON_INACTIVE)}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
