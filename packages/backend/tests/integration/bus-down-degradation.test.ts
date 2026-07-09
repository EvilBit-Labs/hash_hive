/**
 * U3 — Bus-down failure posture: invariant tests.
 *
 * Three assertions in one isolated phase:
 *
 * 1. **Graceful degradation**: a `NotifyBus` whose `openListen` rejects still
 *    completes `start()` without throwing, and local `publish` continues to
 *    deliver to `localBus` subscribers. The logger captures the error.
 *
 * 2. **Locked invariant**: `updateTaskProgress`'s preemption stop signal is
 *    derived purely from the task's `status` read from Postgres. When the DB
 *    returns `{ status: 'paused', ... }`, the function returns
 *    `{ stopped: true }` — no bus is wired, no NOTIFY is consulted.
 *
 * 3. **Drift guard**: `tasks.ts` does not import from `notify-bus` or any
 *    listen-based path for its return values. Asserted via a source-text grep
 *    so the invariant breaks at the import level if someone adds a bus
 *    dependency later.
 *
 * Runs in an isolated bun:test phase (`BUS_DOWN_DEGRADATION_TEST_ISOLATED=1`)
 * because test 2 uses `mock.module` for the drizzle client, which replaces
 * modules process-wide and would poison sibling test files if run together.
 * Mirrors the env-gate + skip-stub pattern from `agent-heartbeat.test.ts`.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const IS_ISOLATED = process.env['BUS_DOWN_DEGRADATION_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('bus-down-degradation (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[bus-down-degradation] skipped — set BUS_DOWN_DEGRADATION_TEST_ISOLATED=1 to run; the bus-down suite did NOT execute in this phase.'
      )
      expect(process.env['BUS_DOWN_DEGRADATION_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Mocks ───────────────────────────────────────────────────────────────
  // All mock.module calls must appear before any dynamic import() in the same
  // bun:test module — they patch the module registry at link time.

  mock.module('../../src/config/env.js', () => ({
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'test',
    },
  }))

  mock.module('../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  // ─── Drizzle chain mock (for updateTaskProgress test) ─────────────────
  // `updateTaskProgress` makes two drizzle calls:
  //   1. db.select({...}).from(tasks).innerJoin(campaigns, ...).where(...).limit(1)
  //      → returns [taskRow]
  //   2. db.update(tasks).set(...).where(...).returning()   (only when not paused)
  //
  // The paused-status guard fires after call 1 — the update is never reached
  // in the test below, so we only need the select chain.

  type SelectResult = Record<string, unknown>[]
  let selectQueue: SelectResult[] = []

  function buildSelectChain(rows: SelectResult) {
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      orderBy: () => Promise.resolve(rows),
    }
    // Thenable so `await db.select(...)...` without an explicit terminal
    // method also resolves.
    // oxlint-disable-next-line unicorn/no-thenable -- intentional test double mimicking drizzle query builder
    chain['then'] = (resolve: (v: unknown) => void) => Promise.resolve(rows).then(resolve)
    return chain
  }

  const mockDbSelect = mock(() => {
    const rows = selectQueue.shift() ?? []
    return buildSelectChain(rows)
  })

  mock.module('../../src/db/index.js', () => ({
    db: {
      select: mockDbSelect,
      update: mock(() => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      })),
      insert: mock(() => ({
        values: () => ({ returning: () => Promise.resolve([]) }),
      })),
    },
  }))

  // Stub side-effect modules that tasks.ts imports at load time so the
  // dynamic import below doesn't attempt live network/redis connections.
  mock.module('../../src/services/agents.js', () => ({
    getAgentBenchmarkForMode: mock(() => Promise.resolve([])),
  }))
  mock.module('../../src/services/attacks/complexity.js', () => ({
    computeAttackKeyspace: mock(() => Promise.resolve(0n)),
    // services/tasks.js now transitively imports services/resources.js
    // (via ./tasks/task-resources.js, #108 U6), which statically imports
    // this module's recomputeKeyspaceForResource. This suite only
    // exercises updateTaskProgress, not any resource upload path, so a
    // no-op stub is sufficient — but it must be present or the real
    // `services/tasks.js` import below fails to link.
    recomputeKeyspaceForResource: mock(() => Promise.resolve()),
  }))
  mock.module('../../src/services/campaigns.js', () => ({
    enqueuePreemptionEvaluation: mock(() => Promise.resolve()),
    updateCampaignProgress: mock(() => Promise.resolve()),
    // tasks.ts's generateTasksForAttack statically imports this (issue #106
    // U6 permanence latch); the named import fails to link if the mock
    // omits it. This suite only exercises updateTaskProgress, not
    // generateTasksForAttack, so a no-op stub is sufficient.
    latchAttackPermanent: mock(() => Promise.resolve()),
  }))
  mock.module('../../src/services/chunk-sizing.js', () => ({
    pickChunkSize: mock(() => 1000n),
    pickParcelSize: mock(() => '1000'),
  }))
  mock.module('../../src/services/events.js', () => ({
    emitCrackResult: mock(() => Promise.resolve()),
    emitTaskUpdate: mock(() => Promise.resolve()),
  }))
  mock.module('../../src/services/tasks/_internals.js', () => ({
    jsonSafeBigint: mock((v: unknown) => v),
    readKeyspaceProgress: mock(() => 0n),
    readWorkRangeField: mock(() => 0n),
  }))

  // ─── Import real modules under test ──────────────────────────────────
  // Dynamic imports must come AFTER all mock.module calls.

  const { InProcessBus } = await import('../../src/services/events/bus.js')
  const { NotifyBus } = await import('../../src/services/events/notify-bus.js')
  const { updateTaskProgress } = await import('../../src/services/tasks.js')

  // ─── Test 1: Graceful degradation ───────────────────────────────────

  describe('NotifyBus graceful degradation when openListen rejects', () => {
    it('completes start() without throwing when openListen rejects', async () => {
      // Arrange
      const localBus = new InProcessBus()
      const notifyMock = mock(() => Promise.resolve())
      const loggerMock = {
        warn: mock(),
        error: mock(),
        debug: mock(),
      }
      const failingOpenListen = () => Promise.reject(new Error('DB unreachable'))

      const bus = new NotifyBus({
        localBus,
        notify: notifyMock,
        selfId: 'test-process-1',
        channel: 'hashhive:events',
        logger: loggerMock,
        openListen: failingOpenListen,
      })

      // Act
      await expect(bus.start()).resolves.toBeUndefined()

      // Assert: logger captured the listen failure
      expect(loggerMock.error).toHaveBeenCalledTimes(1)
      const [errorObj, errorMsg] = loggerMock.error.mock.calls[0] as [
        Record<string, unknown>,
        string,
      ]
      expect(errorObj['err']).toBeInstanceOf(Error)
      expect(errorMsg).toMatch(/failed to open listen/)
    })

    it('delivers local publish to subscribers when openListen has failed', async () => {
      // Arrange
      const localBus = new InProcessBus<{ type: string }>()
      const notifyMock = mock(() => Promise.resolve())
      const loggerMock = { warn: mock(), error: mock(), debug: mock() }
      const failingOpenListen = () => Promise.reject(new Error('DB unreachable'))

      const bus = new NotifyBus({
        localBus,
        notify: notifyMock,
        selfId: 'test-process-2',
        channel: 'hashhive:events',
        logger: loggerMock,
        openListen: failingOpenListen,
      })

      await bus.start()

      const received: { type: string }[] = []
      localBus.subscribe((event) => {
        received.push(event)
      })

      // Act: publish on localBus — should still deliver in-process
      const testEvent = { type: 'task_update' }
      await localBus.publish(testEvent)

      // Assert: subscriber received the event even though cross-process
      // delivery is degraded
      expect(received).toHaveLength(1)
      expect(received[0]).toBe(testEvent)

      // The publisher path (notify) is still attempted for local events
      // (NotifyBus subscribed to localBus before openListen ran)
      expect(notifyMock).toHaveBeenCalledTimes(1)
    })
  })

  // ─── Test 2: Locked invariant — stop signal from DB, not bus ────────

  describe('updateTaskProgress: preemption stop derived from DB status, not bus', () => {
    it('returns { stopped: true } when DB row has status paused — no bus wired', async () => {
      // Arrange: queue a select result with status 'paused'. No bus, no
      // LISTEN connection is configured — the stop signal must come from
      // the DB row alone.
      selectQueue = [
        [
          {
            taskId: 42,
            attackId: 7,
            campaignId: 3,
            status: 'paused',
            startedAt: new Date(),
            projectId: 1,
            hashListId: 10,
          },
        ],
      ]

      // Act
      const result = await updateTaskProgress(42, 99, {
        status: 'running',
        progress: { keyspaceProgress: 500 },
      })

      // Assert: the function short-circuits at the paused guard and returns
      // the stop signal — never reaching the update query
      expect(result).toEqual({ stopped: true })
      // The select was consumed; no update was issued
      expect(mockDbSelect).toHaveBeenCalledTimes(1)
    })
  })

  // ─── Test 3: Drift guard — tasks.ts must not import notify-bus ──────

  describe('invariant guard: tasks.ts has no notify-bus or listen dependency', () => {
    it('tasks.ts source does not import from notify-bus or any listen module', () => {
      const tasksPath = resolve(import.meta.dir, '../../src/services/tasks.ts')
      const source = readFileSync(tasksPath, 'utf8')

      // The stop-signal decision path must never depend on the bus transport.
      // If someone adds such an import, this test fails and forces a
      // conscious architectural review.
      expect(source).not.toMatch(/notify-bus/)
      expect(source).not.toMatch(/openListen/)
      expect(source).not.toMatch(/closeListen/)
      expect(source).not.toMatch(/NOTIFY_CHANNEL/)
    })
  })
}
