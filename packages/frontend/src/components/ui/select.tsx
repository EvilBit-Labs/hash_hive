import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '../../lib/utils'

// Internal sentinel used to represent the empty-string value in Radix Select,
// which does not allow value="" on SelectItem (reserved for uncontrolled clear).
const EMPTY_SENTINEL = '__NONE__'

function toRadixValue(v: string): string {
  return v === '' ? EMPTY_SENTINEL : v
}

function fromRadixValue(v: string): string {
  return v === EMPTY_SENTINEL ? '' : v
}

function SelectRoot({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default'
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'item-aligned',
  align = 'center',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

// ---------------------------------------------------------------------------
// Options-array wrapper (KTD-7)
//
// Thin facade that accepts a flat `options` array and composes the Radix
// primitives internally. This keeps all 8 callsites at roughly the same
// verbosity as the native-select wrapper they replace, while giving the app
// Radix's keyboard nav, focus management, and portal stacking for free.
//
// Empty-string values are mapped through the EMPTY_SENTINEL to satisfy
// Radix's constraint that item values must be non-empty strings.
//
// The wrapper is exported as `Select` so most callsites need only change
// `onChange={(e) => fn(e.target.value)}` → `onValueChange={fn}` and
// replace `<option>` children with an `options` array.
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string
  label: string
  /** When true, renders the option as non-interactive (greyed out). */
  disabled?: boolean
}

export interface SelectProps {
  /** The current value (controlled). Use '' for "no selection" / placeholder. */
  value: string
  /** Called with the newly selected value ('' when the sentinel is picked). */
  onValueChange: (value: string) => void
  /** Flat list of options to render. */
  options: SelectOption[]
  /** Accessible label. Forwarded to SelectTrigger's aria-label. */
  'aria-label'?: string
  /**
   * Placeholder text shown when value is ''. Rendered as a sentinel option that
   * maps back to '' when selected. MUTUALLY EXCLUSIVE with an `options` entry
   * whose `value` is '' — both map to the same internal empty sentinel and would
   * collide (the second wins, the placeholder item vanishes). Use `placeholder`
   * OR an empty-value option, never both. When `value` may be '' and no
   * `placeholder` is given, the trigger renders blank (the empty sentinel
   * matches no rendered item) — always pass `placeholder` for clearable selects.
   */
  placeholder?: string
  /** Disables the trigger. */
  disabled?: boolean
  /** Additional classes forwarded to the trigger element. */
  className?: string
  /**
   * Optional id forwarded to the trigger so a sibling `<label htmlFor>` can
   * associate with it for click-to-focus. The accessible name still comes from
   * `aria-label`.
   */
  id?: string
  /**
   * Forwarded to SelectRoot.onOpenChange. Useful for lazy-loading option data
   * when the user first opens the dropdown (callsites previously triggered this
   * with native onFocus/onMouseDown on the old `<select>`).
   */
  onOpenChange?: (open: boolean) => void
}

function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  id,
  onOpenChange,
  'aria-label': ariaLabel,
}: SelectProps) {
  if (import.meta.env.DEV) {
    if (placeholder !== undefined && options.some((o) => o.value === '')) {
      // oxlint-disable-next-line no-console
      console.error(
        'Select: `placeholder` and an option with value="" both map to the empty sentinel and collide — use one or the other.'
      )
    }
    if (options.some((o) => o.value === EMPTY_SENTINEL)) {
      // oxlint-disable-next-line no-console
      console.error(`Select: an option uses the reserved sentinel value "${EMPTY_SENTINEL}".`)
    }
  }

  const radixValue = toRadixValue(value)

  return (
    <SelectRoot
      value={radixValue}
      onValueChange={(v) => onValueChange(fromRadixValue(v))}
      {...(disabled !== undefined ? { disabled } : {})}
      {...(onOpenChange !== undefined ? { onOpenChange } : {})}
    >
      <SelectTrigger aria-label={ariaLabel} id={id} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start" sideOffset={4}>
        {placeholder !== undefined && <SelectItem value={EMPTY_SENTINEL}>{placeholder}</SelectItem>}
        {options.map((opt) => (
          <SelectItem
            key={opt.value}
            value={toRadixValue(opt.value)}
            {...(opt.disabled === true ? { disabled: true } : {})}
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
