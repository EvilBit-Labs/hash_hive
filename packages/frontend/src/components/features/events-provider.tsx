import { createContext, type ReactNode, useContext } from 'react';
import { useEvents } from '../../hooks/use-events';

interface EventsContextValue {
  connected: boolean;
  polling: boolean;
}

const EventsContext = createContext<EventsContextValue | null>(null);

/**
 * App-level WebSocket-events provider. Mounting this once at the layout
 * root means the entire authenticated tree shares a single WebSocket
 * connection — previously each consumer of `useEvents()` opened its own,
 * so navigating to the agent detail page while the sidebar was visible
 * spun up two redundant connections per project.
 *
 * Consumers read `connected` / `polling` via `useEventsConnection()`.
 * Subscribing to specific event types is still done by calling
 * `useEvents({ types, onEvent })` directly — that path is reserved for
 * components that want a callback handler, and bypasses the shared
 * provider (rare; today only used inside the provider itself).
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const value = useEvents();
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEventsConnection(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) {
    // Outside the provider — return a stable disconnected snapshot so
    // tests and one-off renders don't have to mount the provider.
    return { connected: false, polling: false };
  }
  return ctx;
}
