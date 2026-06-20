/**
 * Real-DB transport test for `NotifyBus`.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts).
 * Uses two independent `postgres()` instances — one per bus — so the
 * module-level pooled `client` from `src/db/index.ts` is never imported
 * or closed here. `harness.test.ts` owns that client.
 *
 * Topology:
 *   sqlA  — bus A's listen connection (also used for notify via a separate tag)
 *   sqlANotify — bus A's notify path (dedicated so listen + notify don't block each other)
 *   sqlB  — bus B's listen connection
 *   sqlBNotify — bus B's notify path
 *
 * Each bus is configured with its own `InProcessBus` as `localBus` so the
 * test can observe delivery without touching the module-level `appBus`.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import postgres from 'postgres'

import { InProcessBus } from '../../src/services/events/bus.js'
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  NOTIFY_CHANNEL,
  NotifyBus,
} from '../../src/services/events/notify-bus.js'

// ─── Test helpers ────────────────────────────────────────────────────────────

const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://hashhive:hashhive@127.0.0.1:5432/hashhive_test'

/** Short poll: resolve when `check()` returns truthy, or reject after timeout. */
async function waitFor(check: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('waitFor: timed out')
}

// ─── Connection management ──────────────────────────────────────────────────
// The test owns all postgres() instances and closes them in afterAll.
// Each NotifyBus instance gets its own listen connection injected via
// `openListen`, plus a separate notify client so listen and notify don't
// share a single max:1 slot.

const listenConns: ReturnType<typeof postgres>[] = []
const notifyConns: ReturnType<typeof postgres>[] = []

function makeListenConn(): ReturnType<typeof postgres> {
  const c = postgres(DB_URL, { max: 1, idle_timeout: 0, connect_timeout: 10 })
  listenConns.push(c)
  return c
}

function makeNotifyConn(): ReturnType<typeof postgres> {
  const c = postgres(DB_URL, { max: 2, idle_timeout: 30, connect_timeout: 10 })
  notifyConns.push(c)
  return c
}

afterAll(async () => {
  // Close all connections opened by this test file.
  await Promise.all([
    ...listenConns.map((c) => c.end({ timeout: 5 }).catch(() => undefined)),
    ...notifyConns.map((c) => c.end({ timeout: 5 }).catch(() => undefined)),
  ])
})

// ─── Bus factory ─────────────────────────────────────────────────────────────

type SimpleEvent = {
  type: string
  projectId: number
  data: Record<string, unknown>
  timestamp: string
}

interface TestBusResult {
  bus: NotifyBus<SimpleEvent>
  localBus: InProcessBus<SimpleEvent>
  received: SimpleEvent[]
  unsubscribeLocal: () => void
}

function makeTestBus(selfId: string): TestBusResult {
  const localBus = new InProcessBus<SimpleEvent>()
  const notifyConn = makeNotifyConn()
  const listenConn = makeListenConn()

  const received: SimpleEvent[] = []
  const unsubscribeLocal = localBus.subscribe((event) => {
    received.push(event)
  })

  const notifyFn = async (channel: string, payload: string): Promise<void> => {
    await notifyConn`SELECT pg_notify(${channel}, ${payload})`
  }

  const openListen = async (
    channel: string,
    onPayload: (p: string) => void
  ): Promise<() => Promise<void>> => {
    await listenConn.listen(channel, onPayload)
    // Closer: unlisten only — test owns the connection end() in afterAll.
    return async () => {
      await listenConn.unlisten(channel)
    }
  }

  const bus = new NotifyBus<SimpleEvent>({
    localBus,
    notify: notifyFn,
    selfId,
    channel: NOTIFY_CHANNEL,
    logger: {
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    openListen,
  })

  return { bus, localBus, received, unsubscribeLocal }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NotifyBus real-DB transport', () => {
  it('delivers an event from bus A to bus B via pg_notify / listen roundtrip', async () => {
    const idA = 'test-self-A-' + Math.random().toString(36).slice(2)
    const idB = 'test-self-B-' + Math.random().toString(36).slice(2)

    const a = makeTestBus(idA)
    const b = makeTestBus(idB)

    await a.bus.start()
    await b.bus.start()

    const event: SimpleEvent = {
      type: 'task_update',
      projectId: 1,
      data: { taskId: 42 },
      timestamp: new Date().toISOString(),
    }

    // Publish on A's localBus — the NotifyBus publisher subscriber picks it up
    // and issues pg_notify; bus B's listen connection receives and republishes.
    await a.localBus.publish(event)

    // B's received array is populated by the local-bus subscriber registered above.
    await waitFor(() => b.received.length > 0)

    expect(b.received).toHaveLength(1)
    expect(b.received[0]).toMatchObject({ type: 'task_update', projectId: 1 })

    await a.bus.stop()
    await b.bus.stop()
    a.unsubscribeLocal()
    b.unsubscribeLocal()
  })

  it('suppresses self-echo: bus A does not re-deliver its own NOTIFY', async () => {
    const selfId = 'test-self-echo-' + Math.random().toString(36).slice(2)
    const a = makeTestBus(selfId)

    await a.bus.start()

    const event: SimpleEvent = {
      type: 'agent_status',
      projectId: 2,
      data: { agentId: 7 },
      timestamp: new Date().toISOString(),
    }

    await a.localBus.publish(event)

    // Allow time for the echo to arrive (if suppression were broken).
    await new Promise((r) => setTimeout(r, 300))

    // A's received array should have exactly 1 entry (the original local publish),
    // not 2 (which would indicate the self-echo was re-delivered).
    expect(a.received).toHaveLength(1)

    await a.bus.stop()
    a.unsubscribeLocal()
  })

  it('issues no pg_notify when localBus.publish is never called (rolled-back handler path)', async () => {
    // A handler that throws before reaching bus.publish simulates a rolled-back
    // transaction — the NOTIFY must not be issued.
    const selfId = 'test-no-notify-' + Math.random().toString(36).slice(2)
    const otherSelfId = 'test-no-notify-b-' + Math.random().toString(36).slice(2)

    const a = makeTestBus(selfId)
    const b = makeTestBus(otherSelfId)

    await a.bus.start()
    await b.bus.start()

    // Deliberately do NOT call localBus.publish — simulates a handler that
    // threw before the emit reached the bus (rolled-back transaction posture).
    // No pg_notify is issued, so B's received stays empty.
    await new Promise((r) => setTimeout(r, 300))

    expect(b.received).toHaveLength(0)

    await a.bus.stop()
    await b.bus.stop()
    a.unsubscribeLocal()
    b.unsubscribeLocal()
  })

  it('remote-injected event is not re-notified (WeakSet re-entrancy guard)', async () => {
    // Verifies that when B receives a NOTIFY from A and re-publishes on
    // B's localBus, B's publisher subscriber skips the pg_notify — otherwise
    // the event would loop indefinitely.
    const notifyCallsB: string[] = []

    const idA = 'test-reentry-A-' + Math.random().toString(36).slice(2)
    const idB = 'test-reentry-B-' + Math.random().toString(36).slice(2)

    // Build B manually so we can intercept notify calls.
    const localBusB = new InProcessBus<SimpleEvent>()
    const notifyConnB = makeNotifyConn()
    const listenConnB = makeListenConn()

    const receivedB: SimpleEvent[] = []
    localBusB.subscribe((event) => {
      receivedB.push(event)
    })

    const busB = new NotifyBus<SimpleEvent>({
      localBus: localBusB,
      notify: async (channel, payload) => {
        notifyCallsB.push(payload)
        await notifyConnB`SELECT pg_notify(${channel}, ${payload})`
      },
      selfId: idB,
      channel: NOTIFY_CHANNEL,
      logger: { warn: () => undefined, error: () => undefined, debug: () => undefined },
      openListen: async (channel, onPayload) => {
        await listenConnB.listen(channel, onPayload)
        return async () => {
          await listenConnB.unlisten(channel)
        }
      },
    })

    const a = makeTestBus(idA)
    await a.bus.start()
    await busB.start()

    const event: SimpleEvent = {
      type: 'crack_result',
      projectId: 3,
      data: { hashItemId: 99 },
      timestamp: new Date().toISOString(),
    }

    await a.localBus.publish(event)

    // Wait for B to receive via listen.
    await waitFor(() => receivedB.length > 0)

    // Allow extra time for any spurious re-notify to fire.
    await new Promise((r) => setTimeout(r, 300))

    // B's notify function must not have been called for the incoming remote event.
    // (It may have been called 0 times since B never locally published anything.)
    expect(notifyCallsB).toHaveLength(0)

    await a.bus.stop()
    await busB.stop()
    a.unsubscribeLocal()
  })

  it('rejects oversized payloads without calling pg_notify', async () => {
    const warnMessages: string[] = []
    const notifyCalls: string[] = []

    const localBus = new InProcessBus<SimpleEvent>()
    const notifyConn = makeNotifyConn()

    // Build a NotifyBus with a spy notify — no listen needed for this test.
    const bus = new NotifyBus<SimpleEvent>({
      localBus,
      notify: async (_ch, payload) => {
        notifyCalls.push(payload)
        await notifyConn`SELECT pg_notify(${NOTIFY_CHANNEL}, ${payload})`
      },
      selfId: 'test-oversized',
      channel: NOTIFY_CHANNEL,
      logger: {
        warn: (_obj, msg) => {
          warnMessages.push(msg)
        },
        error: () => undefined,
        debug: () => undefined,
      },
    })

    await bus.start()

    // Construct an event whose serialized form exceeds MAX_NOTIFY_PAYLOAD_BYTES.
    const bigEvent: SimpleEvent = {
      type: 'task_update',
      projectId: 1,
      data: { blob: 'x'.repeat(MAX_NOTIFY_PAYLOAD_BYTES + 100) },
      timestamp: new Date().toISOString(),
    }

    await localBus.publish(bigEvent)

    // Allow any async path to settle.
    await new Promise((r) => setTimeout(r, 100))

    expect(notifyCalls).toHaveLength(0)
    expect(warnMessages.some((m) => m.includes('payload exceeds size limit'))).toBe(true)

    await bus.stop()
  })
})
