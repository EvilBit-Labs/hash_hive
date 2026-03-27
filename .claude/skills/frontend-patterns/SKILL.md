---
name: frontend-patterns
description: Frontend development patterns for React 19 + Vite SPA, Zustand state management, TanStack Query v5 data fetching, shadcn/ui components, and UI best practices.
origin: ECC
---

# Frontend Development Patterns

> **HashHive stack note:** This skill is optimized for HashHive's React 19 + Vite SPA architecture. No server components, no app router, no Next.js. Data fetching uses TanStack Query v5. Client UI state uses Zustand. Forms use React Hook Form + Zod. UI components use Tailwind CSS + shadcn/ui. Linting/formatting uses Biome (not ESLint, not Prettier).

Modern frontend patterns for React 19, Vite SPAs, and performant user interfaces.

## When to Activate

- Building React components (composition, props, rendering)
- Managing state (useState, useReducer, Zustand)
- Implementing data fetching (TanStack Query v5 — useQuery, useMutation)
- Optimizing performance (memoization, virtualization, code splitting)
- Working with forms (React Hook Form + Zod validation)
- Handling client-side routing and navigation (React Router)
- Building accessible, responsive UI patterns with shadcn/ui + Tailwind CSS

## Component Patterns

### shadcn/ui Component Usage

shadcn/ui provides unstyled, accessible base components that are copied into `packages/frontend/src/components/ui/`. Use these as building blocks — do not import from `shadcn/ui` directly (components live in the local `components/ui/` directory).

```typescript
// ✅ GOOD: Import from local ui directory
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ❌ BAD: Do not import from the shadcn package directly
import { Button } from "shadcn/ui";
```

Feature-specific components live in `components/features/` and compose shadcn/ui primitives:

```typescript
// packages/frontend/src/components/features/agents/AgentStatusBadge.tsx
import { Badge } from '@/components/ui/badge'

interface AgentStatusBadgeProps {
  status: 'active' | 'idle' | 'error' | 'offline'
}

export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
  const variantMap = {
    active: 'default',
    idle: 'secondary',
    error: 'destructive',
    offline: 'outline',
  } as const

  return <Badge variant={variantMap[status]}>{status}</Badge>
}
```

### Composition Over Inheritance

```typescript
// ✅ GOOD: Component composition with shadcn/ui Card primitives
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface StatCardProps {
  title: string
  value: string | number
  description?: string
}

export function StatCard({ title, value, description }: StatCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  )
}
```

### Compound Components

```typescript
// Use React.createContext for tightly-coupled compound components
// For broader state sharing, prefer Zustand (see State Management section)

interface TabsContextValue {
  activeTab: string
  setActiveTab: (tab: string) => void
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined)

export function Tabs({ children, defaultTab }: {
  children: React.ReactNode
  defaultTab: string
}) {
  const [activeTab, setActiveTab] = useState(defaultTab)

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      {children}
    </TabsContext.Provider>
  )
}

export function TabList({ children }: { children: React.ReactNode }) {
  return <div className="tab-list">{children}</div>
}

export function Tab({ id, children }: { id: string, children: React.ReactNode }) {
  const context = useContext(TabsContext)
  if (!context) throw new Error('Tab must be used within Tabs')

  return (
    <button
      className={context.activeTab === id ? 'active' : ''}
      onClick={() => context.setActiveTab(id)}
    >
      {children}
    </button>
  )
}

// Usage
<Tabs defaultTab="overview">
  <TabList>
    <Tab id="overview">Overview</Tab>
    <Tab id="details">Details</Tab>
  </TabList>
</Tabs>
```

## TanStack Query v5 Patterns

TanStack Query v5 is the **only** data fetching layer for server state. Do not use SWR, raw `useEffect` + `fetch`, or React Context for server state.

### Basic Query

```typescript
import { useQuery } from '@tanstack/react-query'

// ✅ GOOD: TanStack Query v5 hook
export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await fetch('/api/v1/dashboard/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      return res.json() as Promise<Agent[]>
    },
  })
}

// Usage in component
export function AgentList() {
  const { data: agents, isLoading, error } = useAgents()

  if (isLoading) return <AgentListSkeleton />
  if (error) return <ErrorMessage error={error} />

  return (
    <div>
      {agents?.map(agent => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  )
}
```

### Mutation with Cache Invalidation

Use `onSuccess(_data, variables)` — not Zustand store state — for cache invalidation keys. Zustand state can be stale at the time the callback fires.

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query'

export function useCreateCampaign() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: CreateCampaignInput) => {
      const res = await fetch('/api/v1/dashboard/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Failed to create campaign')
      return res.json() as Promise<Campaign>
    },
    onSuccess: (_data, _variables) => {
      // Invalidate by key, not by Zustand-derived values
      queryClient.invalidateQueries({ queryKey: ['campaigns'] })
    },
  })
}

// Usage in form component
export function CreateCampaignForm() {
  const createCampaign = useCreateCampaign()

  const handleSubmit = async (data: CreateCampaignInput) => {
    try {
      await createCampaign.mutateAsync(data)
      // Navigate or show success
    } catch (error) {
      // Error handled in mutation; surface to user here
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      {/* fields */}
      <Button type="submit" disabled={createCampaign.isPending}>
        {createCampaign.isPending ? 'Creating...' : 'Create Campaign'}
      </Button>
    </form>
  )
}
```

### Query Key Conventions

```typescript
// ✅ Structured query keys for precise invalidation
const queryKeys = {
  campaigns: {
    all: ["campaigns"] as const,
    list: (projectId: string) => ["campaigns", projectId] as const,
    detail: (id: string) => ["campaigns", "detail", id] as const,
  },
  agents: {
    all: ["agents"] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
  },
};

// Invalidate all campaign queries
queryClient.invalidateQueries({ queryKey: queryKeys.campaigns.all });

// Invalidate only the list for a project
queryClient.invalidateQueries({
  queryKey: queryKeys.campaigns.list(projectId),
});
```

## State Management Patterns

### Zustand for Client UI State

Zustand manages client-side UI state (project selection, filters, wizard steps, sidebar state). Do not use Zustand for server data — that is TanStack Query's responsibility.

```typescript
// packages/frontend/src/stores/uiStore.ts
import { create } from 'zustand'

interface UIState {
  selectedProjectId: string | null
  sidebarOpen: boolean
  setSelectedProjectId: (id: string | null) => void
  toggleSidebar: () => void
}

export const useUIStore = create<UIState>((set) => ({
  selectedProjectId: null,
  sidebarOpen: true,
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}))

// Usage in component
export function ProjectSelector() {
  const { selectedProjectId, setSelectedProjectId } = useUIStore()

  return (
    <Select
      value={selectedProjectId ?? ''}
      onValueChange={setSelectedProjectId}
    >
      {/* options */}
    </Select>
  )
}
```

### Zustand with Slices (larger stores)

```typescript
// packages/frontend/src/stores/campaignWizardStore.ts
import { create } from "zustand";

interface WizardStep {
  id: string;
  completed: boolean;
}

interface CampaignWizardState {
  currentStep: number;
  steps: WizardStep[];
  draftData: Partial<CreateCampaignInput>;
  setCurrentStep: (step: number) => void;
  updateDraft: (data: Partial<CreateCampaignInput>) => void;
  resetWizard: () => void;
}

const initialState = {
  currentStep: 0,
  steps: [
    { id: "basic", completed: false },
    { id: "attacks", completed: false },
    { id: "review", completed: false },
  ],
  draftData: {},
};

export const useCampaignWizardStore = create<CampaignWizardState>((set) => ({
  ...initialState,
  setCurrentStep: (step) => set({ currentStep: step }),
  // Immutable update — always return new objects
  updateDraft: (data) =>
    set((state) => ({ draftData: { ...state.draftData, ...data } })),
  resetWizard: () => set(initialState),
}));
```

## Form Handling Patterns

### React Hook Form + Zod (standard pattern)

All forms use React Hook Form with Zod schemas sourced from `@hashhive/shared`. Do not hand-roll validation with `useState`.

```typescript
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// Use shared Zod schema when available
const createHashListSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  description: z.string().optional(),
})

type CreateHashListInput = z.infer<typeof createHashListSchema>

export function CreateHashListForm({ onSuccess }: { onSuccess: () => void }) {
  const createHashList = useCreateHashList()

  const form = useForm<CreateHashListInput>({
    resolver: zodResolver(createHashListSchema),
    defaultValues: { name: '', description: '' },
  })

  const onSubmit = async (data: CreateHashListInput) => {
    try {
      await createHashList.mutateAsync(data)
      onSuccess()
    } catch (error) {
      form.setError('root', { message: 'Failed to create hash list' })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Hash list name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {form.formState.errors.root && (
          <p className="text-sm text-destructive">
            {form.formState.errors.root.message}
          </p>
        )}

        <Button type="submit" disabled={createHashList.isPending}>
          {createHashList.isPending ? 'Creating...' : 'Create Hash List'}
        </Button>
      </form>
    </Form>
  )
}
```

## Custom Hooks Patterns

### Utility Hook

```typescript
export function useToggle(initialValue = false): [boolean, () => void] {
  const [value, setValue] = useState(initialValue);

  const toggle = useCallback(() => {
    setValue((v) => !v);
  }, []);

  return [value, toggle];
}

// Usage
const [isOpen, toggleOpen] = useToggle();
```

### Debounce Hook

```typescript
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

// Usage
const [searchQuery, setSearchQuery] = useState("");
const debouncedQuery = useDebounce(searchQuery, 500);

// Pass debouncedQuery as a TanStack Query param, not via useEffect
const { data } = useSearchAgents(debouncedQuery);
```

## Performance Optimization

### Memoization

```typescript
// ✅ useMemo for expensive computations
const sortedAgents = useMemo(() => {
  return [...agents].sort((a, b) => a.name.localeCompare(b.name))
}, [agents])

// ✅ useCallback for functions passed to children
const handleSelect = useCallback((agentId: string) => {
  setSelectedId(agentId)
}, [])

// ✅ React.memo for pure components
export const AgentCard = React.memo<AgentCardProps>(({ agent }) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{agent.name}</CardTitle>
      </CardHeader>
    </Card>
  )
})
```

### Code Splitting & Lazy Loading

Vite handles code splitting automatically at route boundaries. Use `lazy` + `Suspense` for heavy feature areas.

```typescript
import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'

// ✅ Lazy load route-level pages
const CampaignDetailPage = lazy(() => import('@/pages/CampaignDetailPage'))
const AgentDetailPage = lazy(() => import('@/pages/AgentDetailPage'))

export function AppRoutes() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
      </Routes>
    </Suspense>
  )
}
```

### Virtualization for Long Lists

```typescript
import { useVirtualizer } from '@tanstack/react-virtual'

export function VirtualHashItemList({ items }: { items: HashItem[] }) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 5,
  })

  return (
    <div ref={parentRef} style={{ height: '600px', overflow: 'auto' }}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <HashItemRow item={items[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}
```

## Error Boundary Pattern

```typescript
interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error boundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex flex-col items-center gap-4 p-8 text-center">
          <p className="text-destructive font-medium">Something went wrong</p>
          <p className="text-sm text-muted-foreground">
            {this.state.error?.message}
          </p>
          <Button
            variant="outline"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}

// Usage
<ErrorBoundary>
  <App />
</ErrorBoundary>
```

## Linting and Formatting

HashHive uses **Biome** for both linting and formatting — not ESLint, not Prettier.

```bash
# Lint and format
bun lint          # biome check (lint only)
bun format        # biome format --write

# Check + auto-fix (safe fixes only — run type-check after unsafe fixes)
biome check --write src/
biome check --write --unsafe src/  # then: bun type-check
```

Biome configuration lives in `biome.json` at the repo root. Do not add `.eslintrc`, `.prettierrc`, or `eslint.config.*` files.

### Biome Suppression

```typescript
// Single-line suppression (place ABOVE the line)
// biome-ignore lint/suspicious/noExplicitAny: third-party type mismatch
const value: any = externalLib.getValue()

// Inside JSX attributes — move inside the tag, above the attribute
<Component
  // biome-ignore lint/a11y/noAutofocus: intentional focus management
  autoFocus
/>
```

## Accessibility Patterns

### Keyboard Navigation

```typescript
export function Dropdown({ options, onSelect }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex(i => Math.min(i + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        onSelect(options[activeIndex])
        setIsOpen(false)
        break
      case 'Escape':
        setIsOpen(false)
        break
    }
  }

  return (
    <div
      role="combobox"
      aria-expanded={isOpen}
      aria-haspopup="listbox"
      onKeyDown={handleKeyDown}
    >
      {/* Dropdown implementation */}
    </div>
  )
}
```

### Focus Management

```typescript
export function Modal({ isOpen, onClose, children }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement
      modalRef.current?.focus()
    } else {
      previousFocusRef.current?.focus()
    }
  }, [isOpen])

  return isOpen ? (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onKeyDown={e => e.key === 'Escape' && onClose()}
    >
      {children}
    </div>
  ) : null
}
```

## Animation Patterns

### Framer Motion Animations

```typescript
import { motion, AnimatePresence } from 'framer-motion'

// ✅ List animations
export function AnimatedList<T extends { id: string }>({
  items,
  renderItem,
}: {
  items: T[]
  renderItem: (item: T) => React.ReactNode
}) {
  return (
    <AnimatePresence>
      {items.map(item => (
        <motion.div
          key={item.id}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          transition={{ duration: 0.2 }}
        >
          {renderItem(item)}
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
```

**Remember**: Choose patterns that fit the feature's complexity. TanStack Query owns server state. Zustand owns client UI state. shadcn/ui provides the component foundation. Biome enforces code style.
