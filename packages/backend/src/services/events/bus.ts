/**
 * In-process EventBus seam for the HashHive event system.
 *
 * This module defines the `EventBus` interface and an `InProcessBus`
 * implementation. The default exported singleton is consumed by
 * `services/events.ts` to fan out events to registered WebSocket clients.
 *
 * Design notes:
 * - `publish()` returns `Promise<void>` to keep the signature compatible
 *   with transport-swappable implementations (e.g. a Postgres LISTEN/NOTIFY
 *   bus in U2). The in-process implementation calls handlers synchronously
 *   before resolving so that callers whose delivery logic has no async seam
 *   (like the WS send loop in events.ts) observe delivery immediately.
 * - New exports MUST live here, NOT in `services/events.ts`, to avoid
 *   breaking ~10 existing `mock.module('.../events.js')` registrations.
 *   See GOTCHAS.md §148.
 */

/**
 * Opaque function returned by `EventBus.subscribe()`. Call it to remove
 * the subscription.
 */
export type Unsubscribe = () => void

/**
 * Handler called synchronously (for the in-process bus) or asynchronously
 * (for future transport implementations) on each published event.
 *
 * `TEvent` is kept generic so the bus module stays decoupled from
 * `AppEvent` — only `services/events.ts` knows that concrete type.
 */
export type EventHandler<TEvent> = (event: TEvent) => void

/**
 * Minimal publish/subscribe seam. The in-process default implementation
 * keeps no external dependencies; a future Postgres transport will satisfy
 * the same interface.
 */
export interface EventBus<TEvent> {
  /**
   * Deliver `event` to all registered subscribers.
   *
   * The in-process implementation delivers synchronously before the
   * returned promise resolves, so callers that fire-and-forget with `void`
   * still observe immediate delivery for the local subscriber.
   */
  publish(event: TEvent): Promise<void>

  /**
   * Register a handler that will be called on every future `publish`.
   * Returns an unsubscribe function; call it to stop delivery.
   */
  subscribe(handler: EventHandler<TEvent>): Unsubscribe
}

/**
 * In-process implementation of `EventBus`. Handlers are called
 * synchronously inside `publish()` before the promise resolves. This
 * ensures that callers which `void`-fire `bus.publish(event)` still
 * observe delivery on the same microtask tick, which is required for the
 * existing synchronous test assertions in `tests/unit/events.test.ts`.
 */
export class InProcessBus<TEvent> implements EventBus<TEvent> {
  private readonly handlers = new Set<EventHandler<TEvent>>()

  publish(event: TEvent): Promise<void> {
    for (const handler of this.handlers) {
      handler(event)
    }
    return Promise.resolve()
  }

  subscribe(handler: EventHandler<TEvent>): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }
}

/**
 * Module-level singleton used by `services/events.ts` to fan out events to
 * local WebSocket clients. Exported here (not from `events.ts`) so:
 *   1. Tests can call `appBus.publish(event)` directly to exercise the
 *      delivery subscriber without going through the convenience emitters.
 *   2. U2 can re-export a `NotifyBus` from this same path, transparently
 *      swapping the transport without touching `events.ts`'s export surface.
 *
 * `AppEvent` is not imported here — the bus is generic and the caller
 * (`services/events.ts`) binds the concrete type when it registers its
 * subscriber.
 *
 * Type param is `unknown` at declaration; cast to the caller's concrete
 * event type when subscribing. Tests that need the typed `AppEvent` should
 * import `AppEvent` from `services/events.js` and cast accordingly.
 */
// Intentionally `any`, not `unknown`: the singleton is decoupled from AppEvent
// at declaration and the production consumer narrows it via
// `const bus: EventBus<AppEvent> = appBus` (events.ts). `unknown` does NOT work
// here — EventBus<unknown> is not assignable to EventBus<AppEvent> because the
// generic flows through the `subscribe(handler)` parameter (contravariant), so
// the assignment in events.ts would fail to type-check. `any` is the escape
// hatch; the single immediate re-narrowing keeps it contained.
// biome-ignore lint/suspicious/noExplicitAny: see above — unknown breaks the EventBus<AppEvent> narrowing
export const appBus = new InProcessBus<any>()
