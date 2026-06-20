/**
 * Unit tests for `services/telemetry.ts` — `appendTaskTelemetry`.
 *
 * Runs in an isolated bun:test phase (TELEMETRY_TEST_ISOLATED=1) because
 * the `mock.module` call replaces `@hashhive/shared`, `db`, and logger
 * process-wide and would poison sibling test files.  Mirrors the env-gate
 * + skip-stub pattern from `tests/unit/services/preemption.test.ts`.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['TELEMETRY_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('telemetry (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[telemetry] skipped — set TELEMETRY_TEST_ISOLATED=1 to run; the telemetry suite did NOT execute in this phase.'
      )
      expect(process.env['TELEMETRY_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Module-level mocks (must precede any dynamic import) ───────────────

  mock.module('../../../src/config/env.js', () => ({
    env: {
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      NODE_ENV: 'test',
    },
  }))

  mock.module('../../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  // Track the values passed to tx.insert().values()
  let capturedInserts: unknown[] = []

  const mockInsertValues = mock((row: unknown) => {
    capturedInserts.push(row)
    return Promise.resolve()
  })

  const mockInsert = mock(() => ({ values: mockInsertValues }))

  // Minimal transaction mock — exposes only `insert`
  const tx = { insert: mockInsert }

  mock.module('../../../src/db/index.js', () => ({
    db: {
      transaction: mock((cb: (t: typeof tx) => unknown) => cb(tx)),
    },
    client: { end: mock() },
  }))

  // Mock @hashhive/shared so `taskTelemetry` is a stable object reference
  const mockTaskTelemetryTable = Symbol('taskTelemetry')
  mock.module('@hashhive/shared', () => ({
    taskTelemetry: mockTaskTelemetryTable,
  }))

  // Dynamic import AFTER all mock.module calls
  const { appendTaskTelemetry } = await import('../../../src/services/telemetry.js')

  // ─── Helpers ────────────────────────────────────────────────────────────

  beforeEach(() => {
    capturedInserts = []
    mockInsert.mockClear()
    mockInsertValues.mockClear()
  })

  // ─── Tests ──────────────────────────────────────────────────────────────

  describe('appendTaskTelemetry', () => {
    it('inserts into the taskTelemetry table with a safe-integer number', async () => {
      await appendTaskTelemetry(tx as never, {
        taskId: 1,
        agentId: 42,
        keyspaceProgress: 500,
        speedHs: 1_000_000,
        temperature: 72.5,
      })

      expect(mockInsert).toHaveBeenCalledTimes(1)
      expect(mockInsert).toHaveBeenCalledWith(mockTaskTelemetryTable)
      expect(mockInsertValues).toHaveBeenCalledTimes(1)

      const row = capturedInserts[0] as Record<string, unknown>
      expect(row['taskId']).toBe(1)
      expect(row['agentId']).toBe(42)
      expect(row['keyspaceProgress']).toBe(500n)
      expect(row['speedHs']).toBe(1_000_000)
      expect(row['temperature']).toBe(72.5)
    })

    it('coerces a digit-only string to bigint', async () => {
      await appendTaskTelemetry(tx as never, {
        taskId: 2,
        agentId: null,
        keyspaceProgress: '9999999999999999',
      })

      const row = capturedInserts[0] as Record<string, unknown>
      expect(row['keyspaceProgress']).toBe(9999999999999999n)
      expect(row['agentId']).toBeNull()
      expect(row['speedHs']).toBeNull()
      expect(row['temperature']).toBeNull()
    })

    it('coerces an invalid keyspace value to 0n', async () => {
      await appendTaskTelemetry(tx as never, {
        taskId: 3,
        agentId: 7,
        keyspaceProgress: 'not-a-number',
      })

      const row = capturedInserts[0] as Record<string, unknown>
      expect(row['keyspaceProgress']).toBe(0n)
    })

    it('coerces a negative number to 0n', async () => {
      await appendTaskTelemetry(tx as never, {
        taskId: 4,
        agentId: null,
        keyspaceProgress: -1,
      })

      const row = capturedInserts[0] as Record<string, unknown>
      expect(row['keyspaceProgress']).toBe(0n)
    })

    it('coerces null/undefined keyspace to 0n', async () => {
      await appendTaskTelemetry(tx as never, {
        taskId: 5,
        agentId: null,
        keyspaceProgress: null,
      })

      const row = capturedInserts[0] as Record<string, unknown>
      expect(row['keyspaceProgress']).toBe(0n)
    })

    it('stores null speedHs and temperature when omitted', async () => {
      await appendTaskTelemetry(tx as never, {
        taskId: 6,
        agentId: 10,
        keyspaceProgress: 0,
      })

      const row = capturedInserts[0] as Record<string, unknown>
      expect(row['speedHs']).toBeNull()
      expect(row['temperature']).toBeNull()
    })
  })
}
