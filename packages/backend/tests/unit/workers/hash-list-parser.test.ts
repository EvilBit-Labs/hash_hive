import type Redis from 'ioredis'

import { describe, expect, mock, test } from 'bun:test'

// Mock the logger
mock.module('../../../src/config/logger.js', () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}))

// Mock DB with chainable query builder
const mockInsertOnConflict = mock(() => Promise.resolve())
const mockInsertValues = mock(() => ({ onConflictDoNothing: mockInsertOnConflict }))
const mockUpdateSetCalls: Array<Record<string, unknown>> = []
// Queue of values for the `.returning()` call following `update.set.where.returning(...)`.
// Each entry becomes the resolved value of the next returning() call.
// Default (empty) returns [{ id: 1 }] = "flipped" so existing tests still see emit.
const returningQueue: Array<Array<{ id: number }>> = []
const mockUpdateReturning = mock(() => Promise.resolve(returningQueue.shift() ?? [{ id: 1 }]))
// .where(...) is awaited in some old call sites (legacy update without .returning).
// We make the returned value a thenable that ALSO carries .returning so both call
// shapes work without splitting the mock per-test.
const mockUpdateSetWhere = mock(() => ({
  returning: mockUpdateReturning,
  // oxlint-disable-next-line unicorn/no-thenable -- mock must satisfy both `await` and `.returning()` chains
  then: (resolve: (v: unknown) => unknown) => resolve(undefined),
}))
// Each entry in countQueueOverrides is consumed left-to-right by successive
// count() selects (total, then cracked). When empty the default is 3/3.
const countQueueOverrides: number[] = []
mock.module('../../../src/db/index.js', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          // If selecting count(), return a count result
          if (fields && 'value' in fields) {
            const value = countQueueOverrides.shift() ?? 3
            return Promise.resolve([{ value }])
          }
          // Otherwise return hash list record (with limit chain)
          return {
            limit: () =>
              Promise.resolve([
                {
                  id: 1,
                  fileRef: { bucket: 'hashhive', key: 'hash-lists/1/test.txt' },
                  projectId: 1,
                },
              ]),
          }
        },
      }),
    }),
    insert: () => ({
      values: mockInsertValues,
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mockUpdateSetCalls.push(values)
        return { where: mockUpdateSetWhere }
      },
    }),
  },
}))

/**
 * Helper: create a ReadableStream from a string (simulates S3 GetObject body).
 */
function stringToReadableStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

const testFileContent = [
  '5f4dcc3b5aa765d61d8327deb882cf99',
  'e99a18c428cb38d5f260853678922e03',
  '098f6bcd4621d373cade4e832627b4f6:test',
].join('\n')

const mockDownloadFile = mock(() =>
  Promise.resolve({
    Body: {
      transformToWebStream: () => stringToReadableStream(testFileContent),
    },
  })
)
mock.module('../../../src/config/storage.js', () => ({
  downloadFile: mockDownloadFile,
}))

// Capture EventService.emitResourceUpdate calls so we can assert payload shape.
const mockEmitResourceUpdate = mock(() => undefined)
mock.module('../../../src/services/events.js', () => ({
  emitResourceUpdate: mockEmitResourceUpdate,
}))

// Mock BullMQ Worker
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
    upsertJobScheduler() {
      return Promise.resolve()
    }
  },
}))

describe('Hash list parser worker', () => {
  test('processor streams file and processes lines', async () => {
    mockUpdateSetCalls.length = 0
    countQueueOverrides.length = 0
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')

    const fakeConnection = {} as Redis
    createHashListParserWorker(fakeConnection)

    expect(capturedProcessor).toBeDefined()

    const fakeJob = {
      id: 'parse-1',
      data: { hashListId: 1, projectId: 1 },
      updateProgress: mock(() => Promise.resolve()),
      opts: { attempts: 3 },
      attemptsMade: 1,
    }

    const result = (await capturedProcessor!(fakeJob)) as {
      inserted: number
      skippedLines: number
    }

    expect(mockDownloadFile).toHaveBeenCalledWith('hash-lists/1/test.txt', 'hashhive')
    expect(result.inserted).toBe(3)
    expect(result.skippedLines).toBe(0)
  })

  test('writes statistics with the {totalCount,crackedCount,crackRate,lastUpdated} shape', async () => {
    mockUpdateSetCalls.length = 0
    countQueueOverrides.length = 0
    // First count() call returns total (4), second returns cracked (1).
    countQueueOverrides.push(4, 1)
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')

    createHashListParserWorker({} as Redis)
    const before = Date.now()
    await capturedProcessor!({
      id: 'parse-2',
      data: { hashListId: 1, projectId: 1 },
      updateProgress: mock(() => Promise.resolve()),
      opts: { attempts: 3 },
      attemptsMade: 1,
    })
    const after = Date.now()

    expect(mockUpdateSetCalls.length).toBeGreaterThan(0)
    const setArgs = mockUpdateSetCalls[mockUpdateSetCalls.length - 1]
    expect(setArgs).toBeDefined()
    expect(setArgs!['status']).toBe('ready')
    const stats = setArgs!['statistics'] as Record<string, unknown>
    expect(stats).toBeDefined()
    expect(stats['totalCount']).toBe(4)
    expect(stats['crackedCount']).toBe(1)
    expect(typeof stats['crackRate']).toBe('number')
    expect(stats['crackRate']).toBeCloseTo(0.25, 5)
    expect(typeof stats['lastUpdated']).toBe('string')
    const lastUpdatedMs = Date.parse(stats['lastUpdated'] as string)
    expect(Number.isNaN(lastUpdatedMs)).toBe(false)
    expect(lastUpdatedMs).toBeGreaterThanOrEqual(before)
    expect(lastUpdatedMs).toBeLessThanOrEqual(after)
    // Legacy keys are gone — the old wire shape must not leak through.
    expect(stats).not.toHaveProperty('total')
    expect(stats).not.toHaveProperty('cracked')
    expect(stats).not.toHaveProperty('remaining')
    expect(stats).not.toHaveProperty('skippedLines')
  })

  test('crackRate is 0 when totalCount is 0 (empty hash list edge case)', async () => {
    mockUpdateSetCalls.length = 0
    countQueueOverrides.length = 0
    countQueueOverrides.push(0, 0)
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')

    createHashListParserWorker({} as Redis)
    await capturedProcessor!({
      id: 'parse-3',
      data: { hashListId: 1, projectId: 1 },
      updateProgress: mock(() => Promise.resolve()),
      opts: { attempts: 3 },
      attemptsMade: 1,
    })

    const setArgs = mockUpdateSetCalls[mockUpdateSetCalls.length - 1]
    const stats = setArgs!['statistics'] as Record<string, unknown>
    expect(stats['totalCount']).toBe(0)
    expect(stats['crackedCount']).toBe(0)
    expect(stats['crackRate']).toBe(0)
  })

  test('parseHashLine: supports 1/2/3-token + 4+-token fallback', async () => {
    mockUpdateSetCalls.length = 0
    countQueueOverrides.length = 0
    mockInsertValues.mockReset()
    mockInsertValues.mockImplementation(() => ({ onConflictDoNothing: mockInsertOnConflict }))
    // Multi-format fixture covering all parser branches.
    const multiFormatContent = [
      // 1 token — plain hash
      '5f4dcc3b5aa765d61d8327deb882cf99',
      // 2 tokens — hash:plaintext
      '098f6bcd4621d373cade4e832627b4f6:test',
      // 3 tokens — username:hash:plaintext
      'admin:e99a18c428cb38d5f260853678922e03:secret',
      // 4+ tokens — hash:plaintext-with:colons (legacy first-colon-as-separator)
      'abc123:pass:with:colons',
    ].join('\n')
    // mockImplementationOnce so the next test sees the original implementation.
    mockDownloadFile.mockImplementationOnce(() =>
      Promise.resolve({
        Body: { transformToWebStream: () => stringToReadableStream(multiFormatContent) },
      })
    )
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')
    createHashListParserWorker({} as Redis)
    await capturedProcessor!({
      id: 'parse-formats',
      data: { hashListId: 1, projectId: 1 },
      updateProgress: mock(() => Promise.resolve()),
      opts: { attempts: 3 },
      attemptsMade: 1,
    })

    // Capture the batch passed to .values()
    const valuesCalls = mockInsertValues.mock.calls
    expect(valuesCalls.length).toBeGreaterThan(0)
    const inserted = valuesCalls.flatMap(
      (call: unknown[]) => call[0] as Array<Record<string, unknown>>
    )
    expect(inserted.length).toBe(4)

    // 1 token: only hashValue
    expect(inserted[0]).toMatchObject({
      hashListId: 1,
      hashValue: '5f4dcc3b5aa765d61d8327deb882cf99',
    })
    expect(inserted[0]?.['plaintext']).toBeUndefined()
    expect(inserted[0]?.['metadata']).toBeUndefined()

    // 2 token: hash:plaintext
    expect(inserted[1]).toMatchObject({
      hashListId: 1,
      hashValue: '098f6bcd4621d373cade4e832627b4f6',
      plaintext: 'test',
    })

    // 3 token: username:hash:plaintext
    expect(inserted[2]).toMatchObject({
      hashListId: 1,
      hashValue: 'e99a18c428cb38d5f260853678922e03',
      plaintext: 'secret',
      metadata: { username: 'admin' },
    })

    // 4+ tokens: legacy first-colon-as-separator (plaintext keeps internal colons)
    expect(inserted[3]).toMatchObject({
      hashListId: 1,
      hashValue: 'abc123',
      plaintext: 'pass:with:colons',
    })
  })

  test('emits resource_update with action=hash_list_ready after successful parse', async () => {
    mockUpdateSetCalls.length = 0
    countQueueOverrides.length = 0
    mockEmitResourceUpdate.mockReset()
    mockEmitResourceUpdate.mockImplementation(() => undefined)
    countQueueOverrides.push(3, 2)
    const { createHashListParserWorker } =
      await import('../../../src/queue/workers/hash-list-parser.js')

    createHashListParserWorker({} as Redis)
    await capturedProcessor!({
      id: 'parse-emit-ready',
      data: { hashListId: 42, projectId: 7 },
      updateProgress: mock(() => Promise.resolve()),
      opts: { attempts: 3 },
      attemptsMade: 1,
    })

    expect(mockEmitResourceUpdate).toHaveBeenCalledTimes(1)
    const [projectId, payload] = mockEmitResourceUpdate.mock.calls[0] as [
      number,
      Record<string, unknown>,
    ]
    expect(projectId).toBe(7)
    expect(payload['action']).toBe('hash_list_ready')
    expect(payload['hashListId']).toBe(42)
    const stats = payload['statistics'] as Record<string, unknown>
    expect(stats['totalCount']).toBe(3)
    expect(stats['crackedCount']).toBe(2)
    expect(stats['crackRate']).toBeCloseTo(2 / 3, 5)
    expect(typeof stats['lastUpdated']).toBe('string')
  })
})
