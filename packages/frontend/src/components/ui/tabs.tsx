import type { ReactNode } from 'react'

import { Tabs as TabsPrimitive } from 'radix-ui'

import { cn } from '../../lib/utils'

/**
 * Thin wrapper around Radix Tabs.Root that:
 * - Preserves the legacy `onChange` prop name (aliased to Radix `onValueChange`)
 * - Strips shadcn's default flex/gap layout so the callsite's `className` prop
 *   drives layout (e.g. `className="space-y-6"` on the campaign-detail page).
 */
interface TabsRootProps {
  readonly value: string
  readonly onChange: (next: string) => void
  readonly children: ReactNode
  readonly className?: string
}

function TabsRoot({ value, onChange, children, className }: TabsRootProps) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onChange} className={className}>
      {children}
    </TabsPrimitive.Root>
  )
}

interface TabsListProps {
  readonly children: ReactNode
  readonly className?: string
  readonly 'aria-label'?: string
}

function TabsList({ children, className, 'aria-label': ariaLabel }: TabsListProps) {
  return (
    <TabsPrimitive.List
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-1 border-b border-surface-1 text-xs', className)}
    >
      {children}
    </TabsPrimitive.List>
  )
}

interface TabsTriggerProps {
  readonly value: string
  readonly children: ReactNode
  readonly className?: string
  readonly disabled?: boolean
}

function TabsTrigger({ value, children, className, disabled = false }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      disabled={disabled}
      className={cn(
        'relative -mb-px inline-flex min-h-[36px] items-center px-3 py-1.5 font-medium transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
        'data-[state=active]:border-primary data-[state=active]:text-foreground',
        className
      )}
    >
      {children}
    </TabsPrimitive.Trigger>
  )
}

interface TabsContentProps {
  readonly value: string
  readonly children: ReactNode
  readonly className?: string
}

function TabsContent({ value, children, className }: TabsContentProps) {
  return (
    <TabsPrimitive.Content value={value} className={cn('outline-none', className)}>
      {children}
    </TabsPrimitive.Content>
  )
}

/**
 * `Tabs` compound component backed by Radix Tabs.
 *
 * Preserves the original public API so the sole callsite (`campaign-detail.tsx`)
 * is untouched. The legacy `onChange` prop is aliased to Radix `onValueChange`.
 *
 * @example
 *   <Tabs value={tab} onChange={setTab} className="space-y-6">
 *     <Tabs.List aria-label="Campaign sections">
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
