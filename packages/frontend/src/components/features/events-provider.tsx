import type { ConnectionStatus } from '@hashhive/shared'

import { createContext, type ReactNode, useContext, useEffect } from 'react'

import { useEvents } from '../../hooks/use-events'
import { authClient } from '../../lib/auth-client'
import { useUiStore } from '../../stores/ui'

interface EventsContextValue {
  status: ConnectionStatus
  connected: boolean
  polling: boolean
}

const EventsContext = createContext<EventsContextValue | null>(null)

/**
 * App-level WebSocket-events provider. Mounting this once at the layout
 * root means the entire authenticated tree shares a single WebSocket
 * connection — previously each consumer of `useEvents()` opened its own,
 * so navigating to the agent detail page while the sidebar was visible
 * spun up two redundant connections per project.
 *
 * Also mirrors `session.session.projectId` → `useUiStore.selectedProjectId`.
 * The BetterAuth session is the server-managed source of truth for project
 * scope (read by the WS upgrade, POST /projects/select, and every dashboard
 * route after issue #159 U4). The UI store is a render-side hint used for
 * query keys and the sidebar dropdown -- it is no longer sent to the
 * backend in any request.
 *
 * Consumers read `status` / `connected` / `polling` via
 * `useEventsConnection()`. The full `ConnectionStatus` union (6 states)
 * is the primary signal; the booleans are kept for back-compat with
 * older call sites. Subscribing to specific event types is still done
 * by calling `useEvents({ types, onEvent })` directly — that path is
 * reserved for components that want a callback handler, and bypasses
 * the shared provider (rare; today only used inside the provider
 * itself).
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const value = useEvents()
  useSyncSessionProject()
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

/**
 * Reflects the BetterAuth session's `projectId` additional-field into
 * the UI store. One-way: session → UI store. Never overwrites a
 * pre-existing UI store value with `undefined` (so a multi-project user
 * pre-selector retains the selection they made via the UI).
 */
function useSyncSessionProject(): void {
  const { data: session } = authClient.useSession()
  const sessionProjectId =
    (session?.session as { projectId?: number | null } | undefined)?.projectId ?? null

  useEffect(() => {
    if (sessionProjectId === null) return
    const { selectedProjectId, setSelectedProject } = useUiStore.getState()
    if (selectedProjectId !== sessionProjectId) {
      setSelectedProject(sessionProjectId)
    }
  }, [sessionProjectId])
}

export function useEventsConnection(): EventsContextValue {
  const ctx = useContext(EventsContext)
  if (!ctx) {
    // Outside the provider — return a stable disconnected snapshot so
    // tests and one-off renders don't have to mount the provider.
    return { status: 'connecting', connected: false, polling: false }
  }
  return ctx
}
