import type Redis from 'ioredis'

import { attacks, maskLists } from '@hashhive/shared'
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
//  - select({fileRef})...limit(1)   -> the resource's file reference
//  - select({lineCount})...limit(1) -> the wordlist line count loadKeyspaceInputs reads
//  - select({keyspace})...limit(1)  -> the masklist keyspace loadKeyspaceInputs reads (#231)
//  - select({id,mode,...}).where()  -> dependent attacks for the fan-out (awaited)
//  - update(maskLists).set({keyspace}) -> the masklist's own summed-keyspace write
//  - update(table).set({lineCount}) -> resource line-count write
//  - update(attacks).set({keyspace}) -> per-dependent attack keyspace write
let resourceFileRef: unknown = { key: 'wordlists/1/list.txt', bucket: 'hashhive' }
let dependentLineCount: number | null = null
let dependentMaskKeyspace: string | null = null
let dependents: Array<Record<string, unknown>> = []
const lineCountWrites: Array<number | null> = []
const keyspaceWrites: Array<number | string | null> = []
const masklistKeyspaceWrites: Array<string | null> = []

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
            if (fields && 'keyspace' in fields) {
              return Promise.resolve([{ keyspace: dependentMaskKeyspace }])
            }
            return Promise.resolve([])
          },
          // oxlint-disable-next-line unicorn/no-thenable -- mock satisfies `await` (dependents) and `.limit()`
          then: (resolve: (v: unknown) => unknown) => resolve(dependents),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        if (table === maskLists && 'keyspace' in values) {
          masklistKeyspaceWrites.push(values['keyspace'] as string | null)
        } else if (table === attacks && 'keyspace' in values) {
          keyspaceWrites.push(values['keyspace'] as number | string | null)
        }
        if ('lineCount' in values && table !== maskLists) {
          lineCountWrites.push(values['lineCount'] as number | null)
        }
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
  resourceType: 'wordlist' | 'rulelist' | 'masklist'
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
  dependentMaskKeyspace = null
  dependents = []
  lineCountWrites.length = 0
  keyspaceWrites.length = 0
  masklistKeyspaceWrites.length = 0
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

  test('sums a masklist keyspace, persists it, and fans out to dependent attacks (#231)', async () => {
    resourceFileRef = { key: 'masklists/1/list.hcmask', bucket: 'hashhive' }
    fileContent = '?l?l\n?d?d?d' // 676 + 1000 = 1676
    dependentMaskKeyspace = '1676' // what the dependent's masklist now reports
    dependents = [
      {
        id: 1,
        mode: 3,
        wordlistId: null,
        rulelistId: null,
        masklistId: 4,
        advancedConfiguration: {},
      },
      {
        id: 2,
        mode: 3,
        wordlistId: null,
        rulelistId: null,
        masklistId: 4,
        advancedConfiguration: {},
      },
    ]

    const result = await runJob({ resourceType: 'masklist', resourceId: 4, projectId: 1 })

    expect(masklistKeyspaceWrites).toEqual(['1676']) // summed once on the masklist row
    expect(keyspaceWrites).toEqual(['1676', '1676']) // fanned out to both attacks
    expect(lineCountWrites).toHaveLength(0) // masklists are not line-counted
    expect(result).toEqual({ keyspace: '1676' })
  })

  test('a masklist with an uncomputable line persists null AND fans the null out to dependents', async () => {
    resourceFileRef = { key: 'masklists/2/custom.hcmask', bucket: 'hashhive' }
    fileContent = '?d?l,abc' // custom-charset definition -> uncomputable
    dependentMaskKeyspace = null // what the dependent's masklist now reports
    // A dependent mode-3 attack already references this masklist. The shared
    // compute-and-persist path MUST fan the null out (clear any stale value),
    // not gate the fan-out on a non-null keyspace — the asymmetry this PR fixes.
    dependents = [
      {
        id: 1,
        mode: 3,
        wordlistId: null,
        rulelistId: null,
        masklistId: 2,
        advancedConfiguration: {},
      },
    ]

    const result = await runJob({ resourceType: 'masklist', resourceId: 2, projectId: 1 })

    expect(masklistKeyspaceWrites).toEqual([null])
    expect(keyspaceWrites).toEqual([null]) // fan-out fired even though keyspace is null
    expect(result).toEqual({ keyspace: null })
  })

  test('a masklist storage-read failure fails the job without persisting a partial keyspace', async () => {
    resourceFileRef = { key: 'masklists/1/list.hcmask', bucket: 'hashhive' }
    fileContent = null // no readable body
    await expect(
      runJob({ resourceType: 'masklist', resourceId: 4, projectId: 1 })
    ).rejects.toThrow()
    expect(masklistKeyspaceWrites).toHaveLength(0)
    expect(keyspaceWrites).toHaveLength(0)
  })
})
