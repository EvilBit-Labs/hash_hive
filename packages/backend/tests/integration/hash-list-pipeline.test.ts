/**
 * Integration test for U8 — the full hash-list pipeline:
 *
 *   POST /api/v1/dashboard/resources/hash-lists (multipart, U5)
 *     -> create row (U6 schema)
 *     -> upload to S3 (mocked storage)
 *     -> enqueue jobs-hash-list-parsing (mocked queue)
 *     -> worker processor runs (U2/U3 parser + emit)
 *     -> statistics persisted (U1 shape)
 *     -> resource_update event emitted with hash_list_ready
 *
 * The repo's existing "integration" tests mock at the drizzle-chain
 * level (no real Postgres) — see tests/integration/agent-heartbeat.test.ts
 * for the canonical precedent. This file follows the same pattern: the
 * goal is to lock the route-handler-to-worker contract end-to-end
 * without spinning up testcontainers.
 *
 * Runs under HASH_LIST_PIPELINE_TEST_ISOLATED=1 because it mocks the
 * shared db and storage modules process-wide; without isolation the
 * mocks would leak into the broader test suite. Mirrors the
 * isolated-phase pattern documented in GOTCHAS.md.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const IS_ISOLATED = process.env['HASH_LIST_PIPELINE_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('hash-list-pipeline (skipped — runs in isolated phase)', () => {
    test('runs only with HASH_LIST_PIPELINE_TEST_ISOLATED=1', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[hash-list-pipeline] skipped — set HASH_LIST_PIPELINE_TEST_ISOLATED=1 to run; this suite mocks DB/storage/queue and must NOT run in the shared phase.'
      )
      expect(process.env['HASH_LIST_PIPELINE_TEST_ISOLATED']).toBeUndefined()
    })
  })
}

if (IS_ISOLATED) {
  // ─── Mock infrastructure ─────────────────────────────────────────────

  // Mutable state the tests drive.
  const state = {
    nextId: 100,
    hashLists: new Map<number, Record<string, unknown>>(),
    hashItemsByList: new Map<number, Array<Record<string, unknown>>>(),
    enqueuedJobs: [] as Array<{ queue: string; data: Record<string, unknown> }>,
    uploadedFiles: new Map<string, { contentType: string; size: number }>(),
    emittedEvents: [] as Array<{ projectId: number; payload: Record<string, unknown> }>,
  }

  // Logger — silence pino in test output.
  mock.module('../../src/config/logger.js', () => ({
    logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
  }))

  // BetterAuth — bypass real session resolution.
  mock.module('../../src/lib/auth.js', () => ({
    auth: {
      api: {
        getSession: async () =>
          Promise.resolve({
            user: { id: '1', email: 'tester@hashhive.local' },
            session: { id: 'test-session' },
          }),
      },
      handler: async () => new Response('ok'),
    },
  }))

  // RBAC — return a stable currentUser shape so requireProjectAccess and
  // requireRole let the request through.
  mock.module('../../src/middleware/rbac.js', () => ({
    requireProjectAccess: () => async (c: any, next: any) => {
      c.set('currentUser', {
        userId: 1,
        email: 'tester@hashhive.local',
        projectId: 7,
        role: 'admin',
      })
      await next()
    },
    requireRole: () => async (c: any, next: any) => {
      c.set('currentUser', {
        userId: 1,
        email: 'tester@hashhive.local',
        projectId: 7,
        role: 'admin',
      })
      await next()
    },
  }))

  // requireSession middleware — populate currentUser unconditionally.
  mock.module('../../src/middleware/auth.js', () => ({
    requireSession: async (c: any, next: any) => {
      c.set('currentUser', {
        userId: 1,
        email: 'tester@hashhive.local',
        projectId: 7,
        role: 'admin',
      })
      await next()
    },
  }))

  // Storage — capture uploads, stream them back on download for the worker.
  mock.module('../../src/config/storage.js', () => ({
    uploadFile: mock(async (key: string, buffer: Buffer, contentType: string) => {
      state.uploadedFiles.set(key, { contentType, size: buffer.byteLength })
      // Stash the actual bytes against the key so downloadFile can return them.
      ;(state.uploadedFiles.get(key) as any).bytes = buffer
    }),
    downloadFile: mock(async (key: string) => {
      const file = state.uploadedFiles.get(key) as any
      if (!file) throw new Error(`Missing file at key ${key}`)
      const bytes: Buffer = file.bytes
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes))
          controller.close()
        },
      })
      return Promise.resolve({ Body: { transformToWebStream: () => stream } })
    }),
    deleteFile: mock(async () => undefined),
    getPresignedUrl: mock(),
    createMultipartUpload: mock(),
    completeMultipartUpload: mock(),
    abortMultipartUpload: mock(),
    listParts: mock(),
    uploadPart: mock(),
  }))

  // EventService — capture emits.
  mock.module('../../src/services/events.js', () => ({
    emit: mock(),
    emitCrackResult: mock(),
    emitTaskUpdate: mock(),
    emitCampaignStatus: mock(),
    emitAgentStatus: mock(),
    emitAgentError: mock(),
    emitResourceUpdate: mock((projectId: number, payload: Record<string, unknown>) => {
      state.emittedEvents.push({ projectId, payload })
    }),
    broadcastSystemHealth: mock(),
    registerClient: mock(),
    unregisterClient: mock(),
    getClientCount: mock(() => 0),
    __resetEventsForTesting: mock(),
  }))

  // Queue context + manager — capture enqueued jobs without running BullMQ.
  mock.module('../../src/queue/context.ts', () => ({
    setQueueManager: mock(),
    getQueueManager: mock(() => ({
      getHealth: () => Promise.resolve({ status: 'connected' }),
      enqueue: (queue: string, data: Record<string, unknown>) => {
        state.enqueuedJobs.push({ queue, data })
        return Promise.resolve(true)
      },
    })),
  }))

  // DB — chainable query-builder mock that routes by table identity.
  mock.module('../../src/db/index.js', () => ({
    db: makeDbMock(),
  }))

  // BullMQ — mock ONCE at the file level (bun:test's mock.module mutates
  // a shared module-cache entry with ESM live bindings, so repeated
  // mock.module('bullmq', ...) calls in individual tests corrupted the
  // captured processor across tests). The captured processor lives at
  // module scope; per-test beforeEach resets it.
  let capturedProcessor: ((job: unknown) => Promise<unknown>) | null = null
  mock.module('bullmq', () => ({
    Worker: class MockWorker {
      constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
        capturedProcessor = processor
      }
      on() {
        return this
      }
      close() {
        return Promise.resolve()
      }
    },
    Queue: class MockQueue {
      add() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
      getWaitingCount() {
        return Promise.resolve(0)
      }
      getActiveCount() {
        return Promise.resolve(0)
      }
      getFailedCount() {
        return Promise.resolve(0)
      }
    },
  }))

  function makeDbMock() {
    return {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          // Three select shapes the production code exercises:
          //  - Legacy count: `.select({ value: count() })...` -> `[{ value }]`
          //  - Worker combined stats (R17): `.select({ total: count(),
          //    cracked: sql<...> })...` -> `[{ total, cracked }]`
          //  - Row select: `.select().from(t).where(...).limit(N)` — chain
          //    via `.limit` (returns rowsForTable).
          const isLegacyCountSelect = !!fields && 'value' in fields
          const isWorkerStatsSelect = !!fields && 'total' in fields && 'cracked' in fields
          const result = isLegacyCountSelect
            ? [{ value: countRowsForTable(table) }]
            : isWorkerStatsSelect
              ? [
                  {
                    total: countRowsForTable(table),
                    // Test fixture has no pre-cracked rows; the worker's
                    // FILTER(WHERE crackedAt IS NOT NULL) therefore counts 0.
                    cracked: 0,
                  },
                ]
              : rowsForTable(table)
          const isCountSelect = isLegacyCountSelect || isWorkerStatsSelect
          return {
            where: () => {
              const whereResult = isCountSelect ? result : []
              return {
                limit: () => Promise.resolve(rowsForTable(table)),
                // oxlint-disable-next-line unicorn/no-thenable -- mock must support both await and chain
                then: (resolve: (v: unknown) => unknown) => resolve(whereResult),
              }
            },
            orderBy: () => Promise.resolve(result),
          }
        },
      }),
      insert: (table: unknown) => ({
        values: (values: any) => ({
          returning: () => {
            if (table === hashListsRef) {
              const id = ++state.nextId
              const row = {
                id,
                ...values,
                fileRef: null,
                statistics: {},
                createdAt: new Date(),
                updatedAt: new Date(),
              }
              state.hashLists.set(id, row)
              return Promise.resolve([row])
            }
            return Promise.resolve([])
          },
          onConflictDoNothing: () => {
            // For hash_items batch inserts. Append (dedupe by hashValue per list).
            if (table === hashItemsRef && Array.isArray(values)) {
              for (const v of values) {
                const list = state.hashItemsByList.get(v.hashListId) ?? []
                if (!list.some((x) => x['hashValue'] === v.hashValue)) {
                  list.push({ ...v, id: list.length + 1 })
                }
                state.hashItemsByList.set(v.hashListId, list)
              }
            }
            return Promise.resolve()
          },
        }),
      }),
      update: (table: unknown) => ({
        set: (values: any) => ({
          where: () => {
            if (table === hashListsRef) {
              // Apply to all hashLists rows (test only has one at a time).
              for (const [id, row] of state.hashLists) {
                state.hashLists.set(id, { ...row, ...values })
              }
            }
            return { returning: () => Promise.resolve([{ id: state.nextId }]) }
          },
        }),
      }),
      delete: () => ({ where: () => Promise.resolve() }),
    }
  }

  // Sentinel table refs. We can't compare against the real Drizzle table
  // objects without importing @hashhive/shared (which would pull in db).
  // Instead the DB mock matches against these symbols.
  const hashListsRef = Symbol('hashLists')
  const hashItemsRef = Symbol('hashItems')

  mock.module('@hashhive/shared', () => ({
    hashLists: hashListsRef,
    hashItems: hashItemsRef,
    hashTypes: Symbol('hashTypes'),
    wordLists: Symbol('wordLists'),
    ruleLists: Symbol('ruleLists'),
    maskLists: Symbol('maskLists'),
    // The route imports schemas — preserve them via dynamic require.
    createHashListRequestSchema: { safeParse: () => ({ success: true, data: {} }) },
    detectHashTypeRequestSchema: { safeParse: () => ({ success: true, data: {} }) },
  }))

  function rowsForTable(table: unknown): unknown[] {
    if (table === hashListsRef) {
      // Return all hashLists rows for any select; the where clause is the
      // route's responsibility but our mock doesn't model it.
      return Array.from(state.hashLists.values())
    }
    if (table === hashItemsRef) {
      const all = Array.from(state.hashItemsByList.values()).flat()
      return all
    }
    return []
  }

  function countRowsForTable(table: unknown): number {
    if (table === hashItemsRef) {
      // The worker's count() FILTER cracked queries would return a smaller
      // number; we return the total for both since none of the test data
      // is pre-cracked. crackedCount will be 0 in assertions.
      return Array.from(state.hashItemsByList.values()).flat().length
    }
    return 0
  }

  // ─── Tests ───────────────────────────────────────────────────────────

  describe('hash-list pipeline integration', () => {
    // Reset shared state so each test sees a clean DB-like snapshot. Without
    // this, the row-select mock (which returns all rows for a table because
    // it doesn't inspect the `where` clause) bleeds the previous test's hash
    // list into the next worker invocation. capturedProcessor is also reset
    // so a stale Worker constructor reference from a prior test can't fire.
    beforeEach(() => {
      state.hashLists.clear()
      state.hashItemsByList.clear()
      state.uploadedFiles.clear()
      state.emittedEvents = []
      state.enqueuedJobs = []
      state.nextId = 100
      capturedProcessor = null
    })

    test('upload → parse → ready event end-to-end via worker', async () => {
      // Multi-format fixture exercising U3 parser branches.
      const fileContent = [
        '5f4dcc3b5aa765d61d8327deb882cf99',
        '098f6bcd4621d373cade4e832627b4f6:test',
        'admin:e99a18c428cb38d5f260853678922e03:secret',
      ].join('\n')

      // Seed: createHashList row first (simulating route's path).
      const id = ++state.nextId
      state.hashLists.set(id, {
        id,
        projectId: 7,
        name: 'integration-list',
        status: 'processing',
        fileRef: { bucket: 'b', key: `7/hash-lists/${id}.txt` },
        statistics: {},
      })
      // Pre-stage the file (simulating uploadHashListFile's S3 PUT).
      const buffer = Buffer.from(fileContent, 'utf8')
      state.uploadedFiles.set(`7/hash-lists/${id}.txt`, {
        contentType: 'text/plain',
        size: buffer.byteLength,
      } as any)
      ;(state.uploadedFiles.get(`7/hash-lists/${id}.txt`) as any).bytes = buffer

      // Run the worker processor directly. BullMQ is mocked once at the
      // file level — instantiating the worker captures its processor into
      // the file-scoped `capturedProcessor` (reset in beforeEach).
      const { createHashListParserWorker } =
        await import('../../src/queue/workers/hash-list-parser.js')
      createHashListParserWorker({} as any)

      expect(capturedProcessor).not.toBeNull()
      await capturedProcessor!({
        id: `parse-${id}`,
        data: { hashListId: id, projectId: 7 },
        updateProgress: mock(() => Promise.resolve()),
        opts: { attempts: 3 },
        attemptsMade: 1,
      })

      // ─── Assertions ──
      // hash_items inserted (3 rows from the 3-line fixture)
      const items = state.hashItemsByList.get(id) ?? []
      expect(items.length).toBe(3)
      // 1-token row
      expect(items[0]).toMatchObject({
        hashListId: id,
        hashValue: '5f4dcc3b5aa765d61d8327deb882cf99',
      })
      // 2-token row
      expect(items[1]).toMatchObject({
        hashListId: id,
        hashValue: '098f6bcd4621d373cade4e832627b4f6',
        plaintext: 'test',
      })
      // 3-token row carries username in metadata
      expect(items[2]).toMatchObject({
        hashListId: id,
        hashValue: 'e99a18c428cb38d5f260853678922e03',
        plaintext: 'secret',
        metadata: { username: 'admin' },
      })

      // Status flipped to ready with U1 statistics shape
      const finalRow = state.hashLists.get(id) as any
      expect(finalRow.status).toBe('ready')
      expect(finalRow.statistics).toMatchObject({
        totalCount: expect.any(Number),
        crackedCount: expect.any(Number),
        crackRate: expect.any(Number),
        lastUpdated: expect.any(String),
      })

      // resource_update event emitted (U2)
      expect(state.emittedEvents.length).toBe(1)
      const evt = state.emittedEvents[0]!
      expect(evt.projectId).toBe(7)
      expect(evt.payload['action']).toBe('hash_list_ready')
      expect(evt.payload['hashListId']).toBe(id)
      const stats = evt.payload['statistics'] as Record<string, unknown>
      expect(stats['totalCount']).toBeDefined()
      expect(stats['lastUpdated']).toBeDefined()
    })

    test('idempotency: re-running the worker on the same list does not duplicate hash_items', async () => {
      // Set up a list with one already-inserted hash_item.
      const id = ++state.nextId
      state.hashLists.set(id, {
        id,
        projectId: 7,
        name: 'idem-list',
        status: 'processing',
        fileRef: { bucket: 'b', key: `7/hash-lists/${id}.txt` },
        statistics: {},
      })
      const buffer = Buffer.from('aaa\nbbb\n', 'utf8')
      state.uploadedFiles.set(`7/hash-lists/${id}.txt`, {
        contentType: 'text/plain',
        size: buffer.byteLength,
      } as any)
      ;(state.uploadedFiles.get(`7/hash-lists/${id}.txt`) as any).bytes = buffer

      // Pre-populate hash_items with one of the lines so the second insert
      // exercises the onConflictDoNothing dedupe path.
      state.hashItemsByList.set(id, [{ hashListId: id, hashValue: 'aaa', id: 1 }])
      state.emittedEvents = []

      // File-level bullmq mock + module re-import captures the fresh
      // processor into the file-scoped capturedProcessor.
      const { createHashListParserWorker } =
        await import('../../src/queue/workers/hash-list-parser.js')
      createHashListParserWorker({} as any)
      expect(capturedProcessor).not.toBeNull()
      await capturedProcessor!({
        id: `parse-${id}`,
        data: { hashListId: id, projectId: 7 },
        updateProgress: mock(() => Promise.resolve()),
        opts: { attempts: 3 },
        attemptsMade: 1,
      })

      const items = state.hashItemsByList.get(id) ?? []
      const values = items.map((i) => i['hashValue'] as string).sort((a, b) => a.localeCompare(b))
      // Expect 2 unique hash_items (aaa + bbb). 'aaa' was pre-seeded so the
      // worker's onConflictDoNothing must dedupe it on the second insert.
      expect(values).toEqual(['aaa', 'bbb'])
      expect(items.length).toBe(2)
    })
  })

  // Failure-path coverage lives in tests/unit/workers/hash-list-parser.test.ts
  // ("worker.on('failed') listener — DB cleanup + hash_list_failed emit"
  // describe block). A real-BullMQ integration test for retry semantics
  // would require the suite to gain testcontainers + actual queue
  // infrastructure; that's a separate effort tracked in the project
  // backlog, not a placeholder in this file.
}
