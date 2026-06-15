import type Redis from 'ioredis'

import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock only the lowest boundaries (logger, bullmq, storage, db). The real
// countLines + recomputeKeyspaceForResource run, so this also exercises the
// worker's count -> persist -> fan-out wiring. (Mocking line-count.js or
// complexity.js here would leak process-wide into the suites that test them.)
mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

function stringToReadableStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

let fileContent: string | null = ''
mock.module('../../../src/config/storage.js', () => ({
  downloadFile: mock(() =>
    Promise.resolve({
      Body:
        fileContent === null
          ? undefined
          : { transformToWebStream: () => stringToReadableStream(fileContent as string) },
    })
  ),
}))

// Field-aware DB mock:
//  - select({fileRef})...limit(1)  -> the resource's file reference
//  - select({lineCount})...limit(1) -> the wordlist line count loadKeyspaceInputs reads
//  - select({id,mode,...}).where()  -> dependent attacks for the fan-out (awaited)
//  - update.set({lineCount})        -> resource line-count write
//  - update.set({keyspace})         -> per-dependent keyspace write
let resourceFileRef: unknown = { key: 'wordlists/1/list.txt', bucket: 'hashhive' }
let dependentLineCount: number | null = null
let dependents: Array<Record<string, unknown>> = []
const lineCountWrites: Array<number | null> = []
const keyspaceWrites: Array<number | string | null> = []

mock.module('../../../src/db/index.js', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (fields && 'fileRef' in fields) {
              return Promise.resolve(
                resourceFileRef === undefined ? [] : [{ fileRef: resourceFileRef }]
              )
            }
            if (fields && 'lineCount' in fields) {
              return Promise.resolve([{ lineCount: dependentLineCount }])
            }
            return Promise.resolve([])
          },
          // oxlint-disable-next-line unicorn/no-thenable -- mock satisfies `await` (dependents) and `.limit()`
          then: (resolve: (v: unknown) => unknown) => resolve(dependents),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        if ('lineCount' in values) lineCountWrites.push(values['lineCount'] as number | null)
        if ('keyspace' in values) keyspaceWrites.push(values['keyspace'] as number | string | null)
        return { where: () => Promise.resolve() }
      },
    }),
  },
}))

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
}))

const { createLineCountWorker } = await import('../../../src/queue/workers/line-count.js')

function runJob(data: {
  resourceType: 'wordlist' | 'rulelist'
  resourceId: number
  projectId: number
}) {
  createLineCountWorker({} as Redis)
  if (!capturedProcessor) throw new Error('processor not captured')
  return capturedProcessor({ id: 'lc-1', data })
}

beforeEach(() => {
  resourceFileRef = { key: 'wordlists/1/list.txt', bucket: 'hashhive' }
  fileContent = ''
  dependentLineCount = null
  dependents = []
  lineCountWrites.length = 0
  keyspaceWrites.length = 0
})

describe('line-count worker', () => {
  test('counts a wordlist, persists lineCount, and recomputes keyspace for a dependent', async () => {
    fileContent = 'aaa\nbbb\nccc\nddd' // 4 lines
    dependentLineCount = 4 // what the dependent's wordlist now reports
    dependents = [
      {
        id: 1,
        mode: 0,
        wordlistId: 5,
        rulelistId: null,
        masklistId: null,
        advancedConfiguration: {},
      },
    ]

    const result = await runJob({ resourceType: 'wordlist', resourceId: 5, projectId: 1 })

    expect(lineCountWrites).toEqual([4])
    expect(keyspaceWrites).toEqual(['4']) // mode 0: wordlist rows * 1
    expect(result).toEqual({ lineCount: 4 })
  })

  test('a resource shared by multiple attacks fans out to all of them', async () => {
    fileContent = 'aaa\nbbb' // 2 lines
    dependentLineCount = 2
    dependents = [
      {
        id: 1,
        mode: 0,
        wordlistId: 5,
        rulelistId: null,
        masklistId: null,
        advancedConfiguration: {},
      },
      {
        id: 2,
        mode: 0,
        wordlistId: 5,
        rulelistId: null,
        masklistId: null,
        advancedConfiguration: {},
      },
    ]

    await runJob({ resourceType: 'wordlist', resourceId: 5, projectId: 1 })

    expect(lineCountWrites).toEqual([2]) // counted once
    expect(keyspaceWrites).toEqual(['2', '2']) // fanned out to both
  })

  test('throws when the resource is missing (no partial write)', async () => {
    resourceFileRef = undefined
    await expect(runJob({ resourceType: 'wordlist', resourceId: 5, projectId: 1 })).rejects.toThrow(
      /not found/i
    )
    expect(lineCountWrites).toHaveLength(0)
  })

  test('throws when the resource has no file reference', async () => {
    resourceFileRef = null
    await expect(runJob({ resourceType: 'wordlist', resourceId: 5, projectId: 1 })).rejects.toThrow(
      /no file reference/i
    )
    expect(lineCountWrites).toHaveLength(0)
  })

  test('a storage-read failure fails the job without persisting a partial lineCount', async () => {
    fileContent = null // simulates a download with no readable body
    await expect(
      runJob({ resourceType: 'wordlist', resourceId: 5, projectId: 1 })
    ).rejects.toThrow()
    expect(lineCountWrites).toHaveLength(0)
    expect(keyspaceWrites).toHaveLength(0)
  })
})
