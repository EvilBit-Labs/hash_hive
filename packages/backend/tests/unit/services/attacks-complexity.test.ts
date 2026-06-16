import { wordLists } from '@hashhive/shared'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Configurable DB mock:
//  - loadKeyspaceInputs: select({lineCount}).from(table).where().limit(1)
//  - recomputeKeyspaceForResource: select({...}).from(attacks).where()  (awaited)
//  - persistAttackKeyspace: update(attacks).set({keyspace}).where()
let wordlistLineCount: number | null = null
let rulelistLineCount: number | null = null
let dependentAttacks: Array<Record<string, unknown>> = []
const keyspaceUpdates: Array<number | string | null> = []

mock.module('../../../src/db/index.js', () => ({
  db: {
    select: (_fields?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { lineCount: table === wordLists ? wordlistLineCount : rulelistLineCount },
            ]),
          // The dependents query awaits the where() result directly (no limit).
          // oxlint-disable-next-line unicorn/no-thenable -- mock satisfies both `await` and `.limit()`
          then: (resolve: (v: unknown) => unknown) => resolve(dependentAttacks),
        }),
      }),
    }),
    update: () => ({
      set: (values: { keyspace?: number | string | null }) => ({
        where: () => {
          keyspaceUpdates.push(values.keyspace ?? null)
          return Promise.resolve()
        },
      }),
    }),
  },
}))

const {
  computeAttackKeyspace,
  estimateSecondsRemaining,
  persistAttackKeyspace,
  recomputeKeyspaceForResource,
} = await import('../../../src/services/attacks/complexity.js')

beforeEach(() => {
  wordlistLineCount = null
  rulelistLineCount = null
  dependentAttacks = []
  keyspaceUpdates.length = 0
})

describe('estimateSecondsRemaining', () => {
  const fleet = [{ speedHs: 300 }]

  test('ceils the a-priori estimate when no work has run', () => {
    // 1000 / 300 = 3.33 -> 4
    expect(estimateSecondsRemaining({ keyspace: '1000', fractionDone: 0, benchmarks: fleet })).toBe(
      4
    )
  })

  test('counts down as the keyspace is covered', () => {
    const apriori = estimateSecondsRemaining({
      keyspace: '1000',
      fractionDone: 0,
      benchmarks: fleet,
    })
    const half = estimateSecondsRemaining({
      keyspace: '1000',
      fractionDone: 0.5,
      benchmarks: fleet,
    })
    expect(half).toBe(2) // 500 / 300 -> 2
    expect(Number(half)).toBeLessThan(Number(apriori))
  })

  test('returns 0 (not null) when fully covered', () => {
    expect(estimateSecondsRemaining({ keyspace: '1000', fractionDone: 1, benchmarks: fleet })).toBe(
      0
    )
  })

  test('is stable for a frozen fractionDone (a preempted attack does not inflate)', () => {
    const first = estimateSecondsRemaining({
      keyspace: '1000000',
      fractionDone: 0.25,
      benchmarks: fleet,
    })
    const second = estimateSecondsRemaining({
      keyspace: '1000000',
      fractionDone: 0.25,
      benchmarks: fleet,
    })
    expect(first).toBe(second)
  })

  test('sums fleet throughput and ignores non-positive / non-finite speeds', () => {
    const mixed = [
      { speedHs: 200 },
      { speedHs: 100 },
      { speedHs: 0 },
      { speedHs: -5 },
      { speedHs: NaN },
    ]
    // effective sum 300 -> same as the single-300 fleet
    expect(estimateSecondsRemaining({ keyspace: '1000', fractionDone: 0, benchmarks: mixed })).toBe(
      4
    )
  })

  test('returns a decimal string when the ETA exceeds Number.MAX_SAFE_INTEGER', () => {
    const result = estimateSecondsRemaining({
      keyspace: '100000000000000000000', // 1e20
      fractionDone: 0,
      benchmarks: [{ speedHs: 1 }],
    })
    expect(typeof result).toBe('string')
    expect(result).toBe('100000000000000000000')
  })

  test('null keyspace -> null', () => {
    expect(
      estimateSecondsRemaining({ keyspace: null, fractionDone: 0, benchmarks: fleet })
    ).toBeNull()
  })

  test('empty fleet -> null', () => {
    expect(
      estimateSecondsRemaining({ keyspace: '1000', fractionDone: 0, benchmarks: [] })
    ).toBeNull()
  })

  test('zero keyspace -> null', () => {
    expect(
      estimateSecondsRemaining({ keyspace: '0', fractionDone: 0, benchmarks: fleet })
    ).toBeNull()
  })
})

describe('computeAttackKeyspace', () => {
  test('mode 3 mask resolves without a resource query', async () => {
    // ?d?d?d = 10 * 10 * 10 = 1000
    const ks = await computeAttackKeyspace({
      mode: 3,
      wordlistId: null,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: { mask: '?d?d?d' },
    })
    expect(ks).toBe('1000')
  })

  test('mode 0 multiplies wordlist rows by 1 when no rule list', async () => {
    wordlistLineCount = 5000
    const ks = await computeAttackKeyspace({
      mode: 0,
      wordlistId: 7,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: {},
    })
    expect(ks).toBe('5000')
  })

  test('missing line count leaves keyspace null', async () => {
    wordlistLineCount = null
    const ks = await computeAttackKeyspace({
      mode: 0,
      wordlistId: 7,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: {},
    })
    expect(ks).toBeNull()
  })
})

describe('persistAttackKeyspace', () => {
  test('persists the computed keyspace value', async () => {
    wordlistLineCount = 1234
    const result = await persistAttackKeyspace({
      id: 1,
      mode: 0,
      wordlistId: 7,
      rulelistId: null,
      masklistId: null,
      advancedConfiguration: {},
    })
    expect(result).toBe('1234')
    expect(keyspaceUpdates).toEqual(['1234'])
  })
})

describe('recomputeKeyspaceForResource', () => {
  test('fans out keyspace recompute to every dependent attack', async () => {
    wordlistLineCount = 2000
    dependentAttacks = [
      {
        id: 1,
        mode: 0,
        wordlistId: 9,
        rulelistId: null,
        masklistId: null,
        advancedConfiguration: {},
      },
      {
        id: 2,
        mode: 0,
        wordlistId: 9,
        rulelistId: null,
        masklistId: null,
        advancedConfiguration: {},
      },
    ]
    await recomputeKeyspaceForResource('wordlist', 9)
    expect(keyspaceUpdates).toEqual(['2000', '2000'])
  })

  test('masklist resources do not fan out (line count is not keyspace)', async () => {
    dependentAttacks = [
      {
        id: 1,
        mode: 3,
        wordlistId: null,
        rulelistId: null,
        masklistId: 4,
        advancedConfiguration: {},
      },
    ]
    await recomputeKeyspaceForResource('masklist', 4)
    expect(keyspaceUpdates).toEqual([])
  })
})
