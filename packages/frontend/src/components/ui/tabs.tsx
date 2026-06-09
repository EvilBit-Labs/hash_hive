import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from 'react'

import { cn } from '../../lib/utils'

interface TabsContextValue {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly registerTrigger: (value: string, node: HTMLButtonElement | null) => void
  readonly focusByOffset: (currentValue: string, offset: number) => void
  /** Per-instance prefix for trigger/panel `id` and `aria-labelledby`. */
  readonly idPrefix: string
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) {
    throw new Error(`<${component}> must be used inside <Tabs>`)
  }
  return ctx
}

interface TabsRootProps {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly children: ReactNode
  readonly className?: string
}

/**
 * Compound component for tab UIs.
 *
 * - Parent owns the active `value` and `onChange`; URL-param backing is a
 *   call-site concern (intentionally not built into the primitive).
 * - Children consume context via `Tabs.List`, `Tabs.Trigger`, `Tabs.Content`.
 * - Keyboard: ArrowLeft / ArrowRight move focus + selection across triggers
 *   (wrapping); Enter / Space activate the focused trigger; roving tabindex
 *   (the active trigger is in the tab sequence, the rest are not).
 */
function TabsRoot({ value, onChange, children, className }: TabsRootProps) {
  // Stable per-instance ID prefix so multiple <Tabs> on the same page
  // produce unique trigger/panel ids — and so the panel's aria-labelledby
  // resolves to its own trigger, not a sibling Tabs's.
  const idPrefix = useId()

  // Keep an insertion-ordered registry of trigger refs so keyboard navigation
  // can move focus deterministically regardless of where triggers live in the
  // tree (Tabs.List + Tabs.Trigger are intentionally decoupled).
  const triggersRef = useRef<Map<string, HTMLButtonElement>>(new Map())

  const registerTrigger = useCallback((triggerValue: string, node: HTMLButtonElement | null) => {
    const map = triggersRef.current
    if (node) {
      map.set(triggerValue, node)
    } else {
      map.delete(triggerValue)
    }
  }, [])

  const focusByOffset = useCallback(
    (currentValue: string, offset: number) => {
      const entries = Array.from(triggersRef.current.entries())
      if (entries.length === 0) return
      const currentIndex = entries.findIndex(([v]) => v === currentValue)
      const baseIndex = currentIndex === -1 ? 0 : currentIndex
      const total = entries.length
      const nextIndex = (((baseIndex + offset) % total) + total) % total
      const [nextValue, nextNode] = entries[nextIndex] as [string, HTMLButtonElement]
      nextNode.focus()
      onChange(nextValue)
    },
    [onChange]
  )

  const ctxValue = useMemo<TabsContextValue>(
    () => ({ value, onChange, registerTrigger, focusByOffset, idPrefix }),
    [value, onChange, registerTrigger, focusByOffset, idPrefix]
  )

  return (
    <TabsContext.Provider value={ctxValue}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  )
}

interface TabsListProps {
  readonly children: ReactNode
  readonly className?: string
  readonly 'aria-label'?: string
}

function TabsList({ children, className, 'aria-label': ariaLabel }: TabsListProps) {
  // Calling useTabsContext purely to enforce the "must be inside <Tabs>" invariant.
  useTabsContext('Tabs.List')
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-1 border-b border-surface-1 text-xs', className)}
    >
      {children}
    </div>
  )
}

interface TabsTriggerProps {
  readonly value: string
  readonly children: ReactNode
  readonly className?: string
  readonly disabled?: boolean
}

function TabsTrigger({ value, children, className, disabled = false }: TabsTriggerProps) {
  const {
    value: activeValue,
    onChange,
    registerTrigger,
    focusByOffset,
    idPrefix,
  } = useTabsContext('Tabs.Trigger')
  const isActive = activeValue === value
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const triggerId = `${idPrefix}trigger-${value}`
  const panelId = `${idPrefix}panel-${value}`

  useEffect(() => {
    registerTrigger(value, buttonRef.current)
    return () => {
      registerTrigger(value, null)
    }
  }, [value, registerTrigger])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusByOffset(value, 1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusByOffset(value, -1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onChange(value)
    }
  }

  return (
    <button
      ref={buttonRef}
      id={triggerId}
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={panelId}
      tabIndex={isActive ? 0 : -1}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(value)
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative -mb-px inline-flex min-h-[36px] items-center px-3 py-1.5 font-medium transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        isActive
          ? 'border-b-2 border-primary text-foreground'
          : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {children}
    </button>
  )
}

interface TabsContentProps {
  readonly value: string
  readonly children: ReactNode
  readonly className?: string
}

function TabsContent({ value, children, className }: TabsContentProps) {
  const { value: activeValue, idPrefix } = useTabsContext('Tabs.Content')
  if (activeValue !== value) return null
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}panel-${value}`}
      aria-labelledby={`${idPrefix}trigger-${value}`}
      className={className}
    >
      {children}
    </div>
  )
}

/**
 * `Tabs` compound component.
 *
 * @example
 *   <Tabs value={tab} onChange={setTab}>
 *     <Tabs.List aria-label="Sections">
 *       <Tabs.Trigger value="attacks">Attacks</Tabs.Trigger>
 *       <Tabs.Trigger value="results">Results</Tabs.Trigger>
 *     </Tabs.List>
 *     <Tabs.Content value="attacks">...</Tabs.Content>
 *     <Tabs.Content value="results">...</Tabs.Content>
 *   </Tabs>
 */
export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
})
