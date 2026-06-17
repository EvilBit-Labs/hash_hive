import { agentBenchmarks, attacks, campaigns, tasks } from '@hashhive/shared'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

// Flexible chainable db mock. `from(table)` selects the row set by table
// identity; the returned chain is both awaitable (campaigns/benchmarks) and
// extendable via .groupBy/.orderBy (tasks/attacks).
let aggRows: Array<Record<string, unknown>> = []
let campaignRows: Array<Record<string, unknown>> = []
let benchmarkRows: Array<Record<string, unknown>> = []
let attackRows: Array<Record<string, unknown>> = []

function makeChain(rows: unknown[]) {
  const settled = Promise.resolve(rows)
  const chain = {
    where: () => chain,
    innerJoin: () => chain,
    groupBy: () => settled,
    orderBy: () => settled,
    limit: () => settled,
    // oxlint-disable-next-line unicorn/no-thenable -- mock satisfies `await` and the builder chains
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settled.then(res, rej),
  }
  return chain
}

mock.module('../../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) =>
        makeChain(
          table === tasks
            ? aggRows
            : table === campaigns
              ? campaignRows
              : table === agentBenchmarks
                ? benchmarkRows
                : table === attacks
                  ? attackRows
                  : []
        ),
    }),
  },
}))

const { deriveAttackStatus, deriveAttackRuntimes, getCampaignAttacksWithRuntime } =
  await import('../../../src/services/attacks/runtime.js')

const zero = { total: 0, pending: 0, running: 0, assigned: 0, paused: 0, failed: 0 }

beforeEach(() => {
  aggRows = []
  campaignRows = []
  benchmarkRows = []
  attackRows = []
})

describe('deriveAttackStatus (pure ladder)', () => {
  test('a manually paused campaign overrides the task-level derivation', () => {
    expect(deriveAttackStatus({ ...zero, total: 3, running: 2, pending: 1 }, 'paused')).toBe(
      'paused'
    )
  })

  test('zero tasks -> pending', () => {
    expect(deriveAttackStatus(zero, 'running')).toBe('pending')
  })

  test('all tasks pending -> pending', () => {
    expect(deriveAttackStatus({ ...zero, total: 4, pending: 4 }, 'running')).toBe('pending')
  })

  test('any running -> running', () => {
    expect(deriveAttackStatus({ ...zero, total: 3, running: 1, pending: 2 }, 'running')).toBe(
      'running'
    )
  })

  test('any assigned -> running', () => {
    expect(deriveAttackStatus({ ...zero, total: 2, assigned: 1, pending: 1 }, 'running')).toBe(
      'running'
    )
  })

  test('pending mixed with terminal (no live) -> running', () => {
    // 1 pending + 2 completed (total 3): some progress, more to do.
    expect(deriveAttackStatus({ ...zero, total: 3, pending: 1 }, 'running')).toBe('running')
  })

  test('preemption mix: only paused + pending under a running campaign -> running', () => {
    // pending is live work and outranks paused.
    expect(deriveAttackStatus({ ...zero, total: 3, pending: 2, paused: 1 }, 'running')).toBe(
      'running'
    )
  })

  test('all tasks paused under a running campaign -> paused', () => {
    expect(deriveAttackStatus({ ...zero, total: 2, paused: 2 }, 'running')).toBe('paused')
  })

  test('any failed (no live, no paused) -> failed', () => {
    expect(deriveAttackStatus({ ...zero, total: 3, failed: 1 }, 'running')).toBe('failed')
  })

  test('all terminal-success + campaign completed -> completed', () => {
    expect(deriveAttackStatus({ ...zero, total: 4 }, 'completed')).toBe('completed')
  })

  test('all terminal-success + campaign not completed -> exhausted', () => {
    expect(deriveAttackStatus({ ...zero, total: 4 }, 'running')).toBe('exhausted')
  })
})

describe('deriveAttackRuntimes', () => {
  test('derives status + a counting-down ETA from the aggregate', async () => {
    aggRows = [
      {
        attackId: 1,
        total: 2,
        pending: 0,
        running: 1,
        assigned: 0,
        paused: 0,
        failed: 0,
        covered: '500',
      },
    ]
    campaignRows = [{ id: 10, status: 'running' }]
    benchmarkRows = [{ speedHs: 100 }]

    const runtime = await deriveAttackRuntimes([
      { id: 1, campaignId: 10, projectId: 1, mode: 0, keyspace: '1000' },
    ])
    const rt = runtime.get(1)
    expect(rt?.status).toBe('running')
    // remaining = 1000 * (1 - 500/1000) = 500; ceil(500 / 100) = 5
    expect(rt?.estimatedSecondsRemaining).toBe(5)
  })

  test('an attack with no task rows derives pending with the a-priori ETA', async () => {
    campaignRows = [{ id: 10, status: 'running' }]
    benchmarkRows = [{ speedHs: 100 }]

    const runtime = await deriveAttackRuntimes([
      { id: 7, campaignId: 10, projectId: 1, mode: 0, keyspace: '1000' },
    ])
    const rt = runtime.get(7)
    expect(rt?.status).toBe('pending')
    expect(rt?.estimatedSecondsRemaining).toBe(10) // full keyspace / 100
  })

  test('empty input returns an empty map', async () => {
    expect((await deriveAttackRuntimes([])).size).toBe(0)
  })
})

describe('getCampaignAttacksWithRuntime', () => {
  test('merges persisted attack fields with the derived runtime', async () => {
    attackRows = [
      {
        id: 1,
        campaignId: 10,
        projectId: 1,
        mode: 0,
        keyspace: '1000',
        wordlistId: 5,
        rulelistId: null,
        masklistId: null,
        dependencies: null,
      },
    ]
    aggRows = [
      {
        attackId: 1,
        total: 2,
        pending: 2,
        running: 0,
        assigned: 0,
        paused: 0,
        failed: 0,
        covered: '0',
      },
    ]
    campaignRows = [{ id: 10, status: 'running' }]
    benchmarkRows = [{ speedHs: 100 }]

    const rows = await getCampaignAttacksWithRuntime(10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 1,
      mode: 0,
      status: 'pending',
      keyspace: '1000',
      estimatedSecondsRemaining: 10,
      wordlistId: 5,
    })
  })
})
