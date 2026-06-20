/**
 * Mocked unit tests for `NotifyBus`.
 *
 * Runs in the default `bun test` lane (preload: tests/preload.ts).
 * No real Postgres connection is opened. The `notify` function and
 * `openListen` factory are fakes that let the test drive the listen
 * handler directly.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { InProcessBus } from '../../../src/services/events/bus.js'
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  NOTIFY_CHANNEL,
  NotifyBus,
} from '../../../src/services/events/notify-bus.js'

// ─── Types ───────────────────────────────────────────────────────────────────

type SimpleEvent = {
  type: string
  projectId: number
  data: Record<string, unknown>
  timestamp: string
}

// ─── Test harness ─────────────────────────────────────────────────────────────

interface Harness {
  localBus: InProcessBus<SimpleEvent>
  notifyCalls: Array<{ channel: string; payload: string }>
  warnMessages: Array<{ obj: Record<string, unknown>; msg: string }>
  bus: NotifyBus<SimpleEvent>
  /** Simulate an inbound NOTIFY from a remote process. */
  fireRemote: (payloadStr: string) => void
  selfId: string
}

function makeHarness(opts: { withListen?: boolean; selfId?: string } = {}): Harness {
  const localBus = new InProcessBus<SimpleEvent>()
  const notifyCalls: Array<{ channel: string; payload: string }> = []
  const warnMessages: Array<{ obj: Record<string, unknown>; msg: string }> = []
  const selfId = opts.selfId ?? 'test-self-id'

  let capturedListener: ((payloadStr: string) => void) | null = null

  const notifyFn = async (channel: string, payload: string): Promise<void> => {
    notifyCalls.push({ channel, payload })
  }

  const openListen =
    opts.withListen !== false
      ? async (_channel: string, onPayload: (p: string) => void): Promise<() => Promise<void>> => {
          capturedListener = onPayload
          return async () => {
            capturedListener = null
          }
        }
      : undefined

  const bus = new NotifyBus<SimpleEvent>({
    localBus,
    notify: notifyFn,
    selfId,
    channel: NOTIFY_CHANNEL,
    logger: {
      warn: (obj, msg) => {
        warnMessages.push({ obj, msg })
      },
      error: () => undefined,
      debug: () => undefined,
    },
    openListen,
  })

  const fireRemote = (payloadStr: string): void => {
    if (!capturedListener)
      throw new Error('No listen handler registered — did you call bus.start()?')
    capturedListener(payloadStr)
  }

  return { localBus, notifyCalls, warnMessages, bus, fireRemote, selfId }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NotifyBus (mocked)', () => {
  describe('publisher path', () => {
    let h: Harness

    beforeEach(async () => {
      h = makeHarness()
      await h.bus.start()
    })

    afterEach(async () => {
      await h.bus.stop()
    })

    it('serializes {originId, event} and calls notify once per publish', async () => {
      const event: SimpleEvent = {
        type: 'task_update',
        projectId: 1,
        data: { taskId: 42 },
        timestamp: '2026-06-19T00:00:00.000Z',
      }

      await h.localBus.publish(event)

      expect(h.notifyCalls).toHaveLength(1)
      const call = h.notifyCalls[0]
      expect(call?.channel).toBe(NOTIFY_CHANNEL)

      const parsed = JSON.parse(call?.payload ?? '')
      expect(parsed.originId).toBe(h.selfId)
      expect(parsed.event).toMatchObject({ type: 'task_update', projectId: 1 })
    })

    it('skips pg_notify and logs a warning for oversized payloads', async () => {
      const bigEvent: SimpleEvent = {
        type: 'task_update',
        projectId: 1,
        data: { blob: 'x'.repeat(MAX_NOTIFY_PAYLOAD_BYTES + 100) },
        timestamp: '2026-06-19T00:00:00.000Z',
      }

      await h.localBus.publish(bigEvent)

      expect(h.notifyCalls).toHaveLength(0)
      expect(h.warnMessages.some((w) => w.msg.includes('payload exceeds size limit'))).toBe(true)
    })

    it('does not call notify when localBus.publish is never called', () => {
      // Simulates a handler that threw before reaching the emit call (rolled-back
      // transaction). The bus subscriber only runs on publish, so no notify fires.
      expect(h.notifyCalls).toHaveLength(0)
    })
  })

  describe('subscriber path', () => {
    let h: Harness
    let received: SimpleEvent[]
    let unsubscribe: () => void

    beforeEach(async () => {
      h = makeHarness({ withListen: true })
      await h.bus.start()
      received = []
      unsubscribe = h.localBus.subscribe((event) => {
        received.push(event)
      })
    })

    afterEach(async () => {
      unsubscribe()
      await h.bus.stop()
    })

    it('delivers an inbound payload from a foreign origin to localBus', () => {
      const foreignOrigin = 'foreign-process-id'
      const event: SimpleEvent = {
        type: 'agent_status',
        projectId: 2,
        data: { agentId: 7 },
        timestamp: '2026-06-19T00:00:00.000Z',
      }
      const payloadStr = JSON.stringify({ originId: foreignOrigin, event })

      h.fireRemote(payloadStr)

      expect(received).toHaveLength(1)
      expect(received[0]).toMatchObject({ type: 'agent_status', projectId: 2 })
    })

    it('drops inbound payload whose originId matches selfId (self-echo)', () => {
      const event: SimpleEvent = {
        type: 'task_update',
        projectId: 1,
        data: {},
        timestamp: '2026-06-19T00:00:00.000Z',
      }
      // Same selfId as the bus — this simulates Postgres echoing our own NOTIFY
      // back to our own listen connection (which Postgres does in fact do).
      const payloadStr = JSON.stringify({ originId: h.selfId, event })

      h.fireRemote(payloadStr)

      expect(received).toHaveLength(0)
    })

    it('does not re-notify a remote-injected event (WeakSet re-entrancy guard)', () => {
      const event: SimpleEvent = {
        type: 'crack_result',
        projectId: 3,
        data: { hashItemId: 99 },
        timestamp: '2026-06-19T00:00:00.000Z',
      }
      const payloadStr = JSON.stringify({ originId: 'remote-proc', event })

      // The listen handler adds the event to remoteEvents, then calls
      // localBus.publish. The publisher subscriber should see remoteEvents.has(event)
      // and skip pg_notify.
      h.fireRemote(payloadStr)

      // The event was published locally (delivered to our subscriber above).
      expect(received).toHaveLength(1)
      // But no pg_notify was issued for it.
      expect(h.notifyCalls).toHaveLength(0)
    })

    it('skips a malformed JSON payload and logs a warning', () => {
      h.fireRemote('not-valid-json{{{')

      expect(received).toHaveLength(0)
      expect(h.warnMessages.some((w) => w.msg.includes('failed to parse NOTIFY payload'))).toBe(
        true
      )
    })

    it('skips a payload with unexpected shape and logs a warning', () => {
      // Valid JSON but missing the `originId` field.
      h.fireRemote(JSON.stringify({ event: { type: 'task_update' } }))

      expect(received).toHaveLength(0)
      expect(h.warnMessages.some((w) => w.msg.includes('unexpected payload shape'))).toBe(true)
    })
  })

  describe('stop()', () => {
    it('detaches the publisher subscription so further localBus publishes are not forwarded', async () => {
      const h = makeHarness()
      await h.bus.start()
      await h.bus.stop()

      const event: SimpleEvent = {
        type: 'task_update',
        projectId: 1,
        data: {},
        timestamp: '2026-06-19T00:00:00.000Z',
      }
      await h.localBus.publish(event)

      expect(h.notifyCalls).toHaveLength(0)
    })
  })
})
