/**
 * Postgres LISTEN/NOTIFY transport behind the EventBus seam.
 *
 * `NotifyBus` wraps an existing in-process `localBus` (typically `appBus`)
 * and provides cross-process delivery:
 *
 * - **Publisher path** (all roles): on every local `publish`, serialize the
 *   event and issue a `pg_notify` so other processes on the same channel
 *   receive it.
 * - **Subscriber path** (API role only): listen on a dedicated non-pooled
 *   Postgres connection; decode inbound payloads and re-publish on `localBus`
 *   so the existing `events.ts` WebSocket fan-out delivers them to local
 *   clients.
 *
 * Echo suppression: when a remote event arrives, the listen handler adds the
 * decoded event object to a `WeakSet` **before** calling `localBus.publish`.
 * The publisher subscriber checks `remoteEvents.has(event)` on the same
 * reference; if present, it skips the `pg_notify` so the event is not
 * re-broadcast across processes. `InProcessBus.publish` calls handlers
 * synchronously with the same object reference, which makes the WeakSet guard
 * reliable.
 *
 * Oversized payloads: events are IDs + enums only — well within the 8KB NOTIFY
 * limit. `MAX_NOTIFY_PAYLOAD_BYTES` (~2000) is a safety net. Payloads that
 * exceed it are logged and skipped; the event was already delivered locally.
 *
 * Connection ownership: the `openListen` factory creates the listen connection.
 * Whoever owns the factory closure owns the resulting connection's lifecycle.
 * In production, `createNotifyBus` owns it and `stop()` closes it. In tests,
 * the test owns the connection and the closer only unlistens.
 */

import type { EventBus } from './bus.js'

/**
 * Maximum serialized payload length sent through `pg_notify`. Postgres
 * hard-limits NOTIFY payloads to 8000 bytes; this budget is intentionally
 * conservative: all current events carry IDs + enums only and fit well under
 * 1 KB.
 */
export const MAX_NOTIFY_PAYLOAD_BYTES = 2_000

/** Channel name used by all processes to publish/subscribe events. */
export const NOTIFY_CHANNEL = 'hashhive:events'

// ─── Logger interface ───────────────────────────────────────────────────────
// Accept a minimal subset so `NotifyBus` can be constructed with a custom
// logger in tests without pulling in the full pino dependency.

interface BusLogger {
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
}

// ─── Wire shape ─────────────────────────────────────────────────────────────

interface NotifyPayload {
  originId: string
  event: unknown
}

function isNotifyPayload(v: unknown): v is NotifyPayload {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>)['originId'] === 'string' &&
    'event' in (v as Record<string, unknown>)
  )
}

// ─── OpenListen contract ────────────────────────────────────────────────────

/**
 * Factory that opens a dedicated LISTEN connection on `channel` and calls
 * `onPayload` for each inbound NOTIFY message. Returns a closer function;
 * calling it disconnects (or at minimum, unlistens).
 *
 * Injected so that:
 *   - API role wires in a real postgres `listen()` connection.
 *   - Worker role omits it entirely (publisher-only).
 *   - Tests inject a fake that lets the test drive inbound payloads directly.
 */
export type OpenListen = (
  channel: string,
  onPayload: (payloadStr: string) => void
) => Promise<() => Promise<void>>

// ─── NotifyBus options ──────────────────────────────────────────────────────

export interface NotifyBusOptions<TEvent> {
  /** The local in-process bus to attach to (typically `appBus`). */
  localBus: EventBus<TEvent>
  /** Issues a `pg_notify` on the pooled connection. */
  notify: (channel: string, payload: string) => Promise<void>
  /** Unique per-process identifier for echo suppression. */
  selfId: string
  /** NOTIFY channel name. */
  channel: string
  /** Logger instance. */
  logger: BusLogger
  /**
   * Factory to open the LISTEN connection (API role only).
   * Omit for worker (publisher-only) roles.
   */
  openListen?: OpenListen
}

// ─── NotifyBus ──────────────────────────────────────────────────────────────

/**
 * Attaches to an existing `localBus` and forwards events across process
 * boundaries via Postgres `LISTEN/NOTIFY`. Does not replace the local bus —
 * local delivery still happens through `localBus` as before.
 *
 * Lifecycle:
 *   1. `start()` — subscribe to `localBus` for publishing; open listen
 *      connection for subscriber role.
 *   2. `stop()` — detach publisher subscription; close listen connection.
 */
export class NotifyBus<TEvent extends object> {
  private readonly opts: NotifyBusOptions<TEvent>

  /**
   * Guard set to prevent echoing remote events back across the channel.
   * An event object is added here before `localBus.publish` is called;
   * the publisher subscriber skips `pg_notify` if the reference is present.
   */
  private readonly remoteEvents = new WeakSet<object>()

  private unsubscribePublisher: (() => void) | null = null
  private closeListen: (() => Promise<void>) | null = null

  constructor(opts: NotifyBusOptions<TEvent>) {
    this.opts = opts
  }

  /**
   * Start the bus:
   *  - Register a `localBus` subscriber that forwards events to Postgres.
   *  - Open the listen connection (if `openListen` was provided).
   */
  async start(): Promise<void> {
    this.unsubscribePublisher = this.opts.localBus.subscribe((event) => {
      this.handleLocalEvent(event)
    })

    if (this.opts.openListen) {
      try {
        this.closeListen = await this.opts.openListen(this.opts.channel, (payloadStr) => {
          this.handleRemotePayload(payloadStr)
        })
      } catch (err) {
        this.opts.logger.error({ err }, 'NotifyBus: failed to open listen connection')
        // Non-fatal: the bus degrades to publish-only (worker posture).
        // The API process will not receive cross-process events until the
        // connection recovers. U3 will add reconnect logic.
      }
    }
  }

  /**
   * Stop the bus: detach the publisher subscription and close the listen
   * connection.
   */
  async stop(): Promise<void> {
    if (this.unsubscribePublisher) {
      this.unsubscribePublisher()
      this.unsubscribePublisher = null
    }
    if (this.closeListen) {
      try {
        await this.closeListen()
      } catch (err) {
        this.opts.logger.warn({ err }, 'NotifyBus: error closing listen connection')
      }
      this.closeListen = null
    }
  }

  /** Called for every event published on `localBus`. */
  private handleLocalEvent(event: TEvent): void {
    // Echo-suppression: skip re-notifying an event that was injected by the
    // listen handler (already delivered locally, must not bounce back).
    if (this.remoteEvents.has(event)) {
      return
    }

    const payload = JSON.stringify({ originId: this.opts.selfId, event })
    const byteLength = Buffer.byteLength(payload, 'utf8')

    if (byteLength > MAX_NOTIFY_PAYLOAD_BYTES) {
      this.opts.logger.warn(
        {
          channel: this.opts.channel,
          byteLength,
          limit: MAX_NOTIFY_PAYLOAD_BYTES,
        },
        'NotifyBus: payload exceeds size limit; skipping pg_notify (event delivered locally only)'
      )
      return
    }

    this.opts.notify(this.opts.channel, payload).catch((err) => {
      this.opts.logger.warn({ err, channel: this.opts.channel }, 'NotifyBus: pg_notify failed')
    })
  }

  /** Called for every NOTIFY message received on the listen connection. */
  private handleRemotePayload(payloadStr: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payloadStr)
    } catch (err) {
      this.opts.logger.warn(
        { err, payloadStr },
        'NotifyBus: failed to parse NOTIFY payload; skipping'
      )
      return
    }

    if (!isNotifyPayload(parsed)) {
      this.opts.logger.warn({ parsed }, 'NotifyBus: unexpected payload shape; skipping')
      return
    }

    // Self-echo suppression: discard our own NOTIFYs (already delivered locally).
    if (parsed.originId === this.opts.selfId) {
      return
    }

    // Validate the inner event at the cross-process boundary before
    // republishing to local WS clients (AGENTS.md: never trust external data).
    // Every AppEvent carries a string `type`; a payload from a mismatched
    // rolling-deploy schema that lacks it is dropped rather than delivered.
    if (
      typeof parsed.event !== 'object' ||
      parsed.event === null ||
      typeof (parsed.event as { type?: unknown }).type !== 'string'
    ) {
      this.opts.logger.warn({ parsed }, 'NotifyBus: inbound event has no string `type`; skipping')
      return
    }

    const event = parsed.event as TEvent

    // Mark the event object before publishing so the publisher subscriber
    // does not re-notify it across the channel. InProcessBus delivers
    // synchronously with the same reference, so the WeakSet guard holds.
    this.remoteEvents.add(event)

    try {
      void this.opts.localBus.publish(event)
    } catch (err) {
      this.opts.logger.error({ err }, 'NotifyBus: localBus.publish threw unexpectedly')
    }
  }
}

// ─── Production factory ─────────────────────────────────────────────────────

/**
 * Wire `NotifyBus` against the real infrastructure:
 *   - `localBus` = `appBus` singleton
 *   - `notify` = `pg_notify` via the shared pooled client
 *   - `openListen` = `createListenConnection()` (api role only)
 *
 * Callers must `await bus.start()` and call `bus.stop()` on shutdown.
 *
 * Gated on `env.NODE_ENV !== 'test'` at the call site (`index.ts`), so the
 * mocked test lane never opens a real Postgres connection.
 */
export async function createNotifyBus(role: 'api' | 'worker'): Promise<NotifyBus<object>> {
  // Dynamic imports break the circular-dependency risk between this factory
  // and src/db/index.ts. They also enable bun:test mock.module to intercept
  // the db import without touching the class definition.
  const { appBus } = await import('./bus.js')
  const { client, createListenConnection } = await import('../../db/index.js')
  const { logger: appLogger } = await import('../../config/logger.js')
  const { NOTIFY_CHANNEL: channel } = await import('./notify-bus.js')

  const selfId = crypto.randomUUID()

  const notifyFn = async (ch: string, payload: string): Promise<void> => {
    await client`SELECT pg_notify(${ch}, ${payload})`
  }

  const baseOpts = {
    localBus: appBus,
    notify: notifyFn,
    selfId,
    channel,
    logger: appLogger,
  }

  const bus =
    role === 'api'
      ? new NotifyBus({
          ...baseOpts,
          openListen: async (ch, onPayload) => {
            const listenConn = createListenConnection()
            await listenConn.listen(ch, onPayload)
            return async () => {
              await listenConn.end({ timeout: 5 })
            }
          },
        })
      : new NotifyBus(baseOpts)

  return bus
}
