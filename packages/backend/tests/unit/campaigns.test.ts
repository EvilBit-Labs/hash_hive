import { describe, expect, test } from 'bun:test'

// DAG validation now tests the real exported pure function from the
// campaigns service. The local helper that previously lived here has
// been replaced; if the production behavior drifts, these tests fail.
import { validateProposedDAG } from '../../src/services/campaigns.js'

const validateDAG = validateProposedDAG

describe('DAG validation', () => {
  test('should accept an empty graph', () => {
    expect(validateDAG([])).toEqual({ valid: true })
  })

  test('should accept a single node with no dependencies', () => {
    expect(validateDAG([{ id: 1, dependencies: [] }])).toEqual({ valid: true })
  })

  test('should accept a valid linear chain', () => {
    const result = validateDAG([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [2] },
    ])
    expect(result.valid).toBe(true)
  })

  test('should accept a diamond dependency graph', () => {
    //   1
    //  / \
    // 2   3
    //  \ /
    //   4
    const result = validateDAG([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [1] },
      { id: 4, dependencies: [2, 3] },
    ])
    expect(result.valid).toBe(true)
  })

  test('should reject a direct cycle (A -> B -> A)', () => {
    const result = validateDAG([
      { id: 1, dependencies: [2] },
      { id: 2, dependencies: [1] },
    ])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Circular dependency')
  })

  test('should reject a transitive cycle (A -> B -> C -> A)', () => {
    const result = validateDAG([
      { id: 1, dependencies: [3] },
      { id: 2, dependencies: [1] },
      { id: 3, dependencies: [2] },
    ])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Circular dependency')
  })

  test('should reject a self-loop', () => {
    const result = validateDAG([{ id: 1, dependencies: [1] }])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Circular dependency')
  })

  test('should reject references to non-existent nodes', () => {
    const result = validateDAG([{ id: 1, dependencies: [99] }])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('non-existent')
  })

  test('should accept parallel independent nodes', () => {
    const result = validateDAG([
      { id: 1, dependencies: [] },
      { id: 2, dependencies: [] },
      { id: 3, dependencies: [] },
    ])
    expect(result.valid).toBe(true)
  })
})

// ─── Inline vs Async task generation threshold tests ────────────────

// These tests verify the 99/100 split: inline generation when estimated
// tasks < 100, async queue enqueue when estimated tasks >= 100.
// We import the production helper directly to test the real decision path.

import {
  computeCampaignEta,
  resolveGenerationStrategy,
  shouldAutoCompleteCampaign,
} from '../../src/services/campaigns.js'

// resolveGenerationStrategy estimates with MIN_CHUNK_SIZE so its task count
// is an upper bound on what generateTasksForAttack will actually emit at
// runtime (pickChunkSize can clamp as low as 1000 for slow fleets). The old
// 10M constant under-counted by 4 orders of magnitude when fleet benchmarks
// pushed chunkSize toward the floor.
const CHUNK_SIZE = 1000

describe('Task generation threshold (99/100 split)', () => {
  test('uses inline generation at 1 estimated task', () => {
    // Single attack with no keyspace → 1 estimated task
    expect(resolveGenerationStrategy([{ keyspace: null }])).toBe('inline')
  })

  test('uses inline generation at 99 estimated tasks', () => {
    // 99 attacks each producing 1 task (no keyspace)
    const attacks = Array.from({ length: 99 }, () => ({ keyspace: null }))
    expect(resolveGenerationStrategy(attacks)).toBe('inline')
  })

  test('uses inline generation at 99 estimated tasks from keyspace', () => {
    // Single attack with keyspace that produces exactly 99 chunks at
    // worst-case (MIN_CHUNK_SIZE-basis) sizing.
    const keyspace = String(99 * CHUNK_SIZE)
    expect(resolveGenerationStrategy([{ keyspace }])).toBe('inline')
  })

  test('uses async enqueue at exactly 100 estimated tasks', () => {
    // 100 attacks each producing 1 task (no keyspace)
    const attacks = Array.from({ length: 100 }, () => ({ keyspace: null }))
    expect(resolveGenerationStrategy(attacks)).toBe('async')
  })

  test('uses async enqueue at exactly 100 estimated tasks from keyspace', () => {
    // Single attack with keyspace that produces exactly 100 chunks at
    // worst-case (MIN_CHUNK_SIZE-basis) sizing.
    const keyspace = String(100 * CHUNK_SIZE)
    expect(resolveGenerationStrategy([{ keyspace }])).toBe('async')
  })

  test('uses async enqueue at 101 estimated tasks', () => {
    const attacks = Array.from({ length: 101 }, () => ({ keyspace: null }))
    expect(resolveGenerationStrategy(attacks)).toBe('async')
  })

  test('uses async enqueue for large keyspace', () => {
    // Single attack with massive keyspace → many chunks
    const keyspace = String(500 * CHUNK_SIZE)
    expect(resolveGenerationStrategy([{ keyspace }])).toBe('async')
  })

  test('mixed attacks: total below threshold uses inline', () => {
    // 5 attacks with 10 chunks each + 1 with no keyspace = 51 tasks → inline
    const attacks = [
      ...Array.from({ length: 5 }, () => ({ keyspace: String(10 * CHUNK_SIZE) })),
      { keyspace: null },
    ]
    expect(resolveGenerationStrategy(attacks)).toBe('inline')
  })

  test('mixed attacks: total at threshold uses async', () => {
    // 10 attacks with 10 chunks each = 100 tasks → async
    const attacks = Array.from({ length: 10 }, () => ({
      keyspace: String(10 * CHUNK_SIZE),
    }))
    expect(resolveGenerationStrategy(attacks)).toBe('async')
  })

  // ─── Computable-keyspace routing (post-#96) ─────────────────────────

  test('null keyspace + computable mask attack forces async', () => {
    // generateTasksForAttack will compute ?a^7 ~ 6.98e13 keyspace and may
    // emit up to MAX_CHUNKS_PER_ATTACK chunks - far past the inline cap.
    expect(
      resolveGenerationStrategy([
        {
          keyspace: null,
          mode: 3,
          advancedConfiguration: { mask: '?a?a?a?a?a?a?a' },
        },
      ])
    ).toBe('async')
  })

  test('null keyspace + computable straight attack forces async', () => {
    // Mode 0 with wordlistId set is computable - the calculator will fetch
    // wordlist.lineCount and emit a real keyspace. Force async.
    expect(
      resolveGenerationStrategy([
        { keyspace: null, mode: 0, wordlistId: 42, advancedConfiguration: {} },
      ])
    ).toBe('async')
  })

  test('null keyspace + non-computable mode stays inline (legacy single-placeholder)', () => {
    // Mode 1 (combination) has no second-wordlist field; calculator falls
    // through and emits a single placeholder task. Inline is fine.
    expect(
      resolveGenerationStrategy([
        { keyspace: null, mode: 1, wordlistId: 42, advancedConfiguration: {} },
      ])
    ).toBe('inline')
  })

  test('null keyspace + mode without resource refs stays inline', () => {
    // Mode 0 with no wordlistId - calculator returns null, single placeholder.
    expect(
      resolveGenerationStrategy([
        { keyspace: null, mode: 0, wordlistId: null, advancedConfiguration: {} },
      ])
    ).toBe('inline')
  })

  test('legacy stub without mode info preserves inline-single-placeholder behavior', () => {
    // Existing callers that pass minimal { keyspace: null } stubs (e.g. older
    // tests, queue handlers that haven't been threaded the resource fields)
    // continue to see "1 task -> inline" since mode is undefined.
    expect(resolveGenerationStrategy([{ keyspace: null }])).toBe('inline')
  })
})

// ─── Campaign auto-completion guard ────────────────────────────────

describe('shouldAutoCompleteCampaign', () => {
  test('returns true when running and every task is terminal (completed only)', () => {
    expect(
      shouldAutoCompleteCampaign({
        status: 'running',
        totalTasks: 3,
        completedCount: 3,
        failedCount: 0,
      })
    ).toBe(true)
  })

  test('returns true when running and mix of completed + failed sums to total', () => {
    expect(
      shouldAutoCompleteCampaign({
        status: 'running',
        totalTasks: 5,
        completedCount: 3,
        failedCount: 2,
      })
    ).toBe(true)
  })

  test('returns true when paused and all tasks terminal', () => {
    // Paused-with-all-terminal-tasks is a valid auto-complete trigger:
    // without it, a campaign whose last tasks finish during a pause
    // would stay 'paused' forever with no further trigger to flip it.
    expect(
      shouldAutoCompleteCampaign({
        status: 'paused',
        totalTasks: 3,
        completedCount: 3,
        failedCount: 0,
      })
    ).toBe(true)
  })

  test('returns false when cancelled (terminal status, no recursion)', () => {
    expect(
      shouldAutoCompleteCampaign({
        status: 'cancelled',
        totalTasks: 3,
        completedCount: 3,
        failedCount: 0,
      })
    ).toBe(false)
  })

  test('returns false when draft with zero tasks', () => {
    expect(
      shouldAutoCompleteCampaign({
        status: 'draft',
        totalTasks: 0,
        completedCount: 0,
        failedCount: 0,
      })
    ).toBe(false)
  })

  test('returns false when running but tasks still in-flight', () => {
    expect(
      shouldAutoCompleteCampaign({
        status: 'running',
        totalTasks: 5,
        completedCount: 3,
        failedCount: 1,
      })
    ).toBe(false)
  })

  test('returns false when already completed (no recursion)', () => {
    expect(
      shouldAutoCompleteCampaign({
        status: 'completed',
        totalTasks: 3,
        completedCount: 3,
        failedCount: 0,
      })
    ).toBe(false)
  })
})

// ─── Campaign ETA estimator ─────────────────────────────────────────

describe('computeCampaignEta', () => {
  const baseStart = new Date('2026-01-01T00:00:00.000Z')
  const tenSecondsLater = new Date('2026-01-01T00:00:10.000Z')

  test('returns null when no running tasks', () => {
    expect(
      computeCampaignEta({
        startedAt: baseStart,
        now: tenSecondsLater,
        totalTasks: 10,
        completedCount: 5,
        failedCount: 0,
        runningProgress: 0,
        runningTaskCount: 0,
      })
    ).toBeNull()
  })

  test('returns null when campaign has no startedAt', () => {
    expect(
      computeCampaignEta({
        startedAt: null,
        now: tenSecondsLater,
        totalTasks: 10,
        completedCount: 5,
        failedCount: 0,
        runningProgress: 0.5,
        runningTaskCount: 1,
      })
    ).toBeNull()
  })

  test('returns null when elapsed time < 1 second (no stable rate yet)', () => {
    expect(
      computeCampaignEta({
        startedAt: baseStart,
        now: new Date(baseStart.getTime() + 500),
        totalTasks: 10,
        completedCount: 1,
        failedCount: 0,
        runningProgress: 0.5,
        runningTaskCount: 1,
      })
    ).toBeNull()
  })

  test('returns null when no measurable progress yet', () => {
    expect(
      computeCampaignEta({
        startedAt: baseStart,
        now: tenSecondsLater,
        totalTasks: 10,
        completedCount: 0,
        failedCount: 0,
        runningProgress: 0,
        runningTaskCount: 1,
      })
    ).toBeNull()
  })

  test('returns null when no remaining work', () => {
    expect(
      computeCampaignEta({
        startedAt: baseStart,
        now: tenSecondsLater,
        totalTasks: 10,
        completedCount: 10,
        failedCount: 0,
        runningProgress: 0,
        runningTaskCount: 1,
      })
    ).toBeNull()
  })

  test('returns ISO timestamp in the future when rate and remaining are positive', () => {
    // 5 tasks done in 10s → 0.5 tasks/sec. 5 remaining → 10s more → eta = baseStart + 20s
    const eta = computeCampaignEta({
      startedAt: baseStart,
      now: tenSecondsLater,
      totalTasks: 10,
      completedCount: 5,
      failedCount: 0,
      runningProgress: 0,
      runningTaskCount: 1,
    })
    expect(eta).not.toBeNull()
    expect(new Date(eta as string).getTime()).toBe(tenSecondsLater.getTime() + 10_000)
  })

  test('excludes failed tasks from remaining-work calculation', () => {
    // 4 done + 1 failed, 5 remaining-to-process. rate = 4/10 = 0.4 → 5/0.4 = 12.5s
    const eta = computeCampaignEta({
      startedAt: baseStart,
      now: tenSecondsLater,
      totalTasks: 10,
      completedCount: 4,
      failedCount: 1,
      runningProgress: 0,
      runningTaskCount: 1,
    })
    expect(eta).not.toBeNull()
    expect(new Date(eta as string).getTime()).toBe(tenSecondsLater.getTime() + 12_500)
  })
})

// ─── Transactional create: DAG pre-check ────────────────────────────
//
// createCampaignWithAttacks runs `validateProposedDAG` on index-based
// ids before opening the transaction. We can exercise that pre-check
// directly by feeding the same shape; cycle detection is the property
// we want to lock down here.

describe('Inline-attack DAG pre-check (index-based ids)', () => {
  test('mutual-cycle indices [0]↔[1] are rejected', () => {
    const result = validateProposedDAG([
      { id: 0, dependencies: [1] },
      { id: 1, dependencies: [0] },
    ])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Circular')
  })

  test('out-of-range index is reported as a non-existent dep', () => {
    const result = validateProposedDAG([{ id: 0, dependencies: [5] }])
    expect(result.valid).toBe(false)
    expect(result.error).toContain('non-existent')
  })

  test('valid linear inline chain [0] -> [1] -> [2] is accepted', () => {
    const result = validateProposedDAG([
      { id: 0, dependencies: null },
      { id: 1, dependencies: [0] },
      { id: 2, dependencies: [1] },
    ])
    expect(result.valid).toBe(true)
  })

  test('empty attacks[] is accepted (no graph to check)', () => {
    const result = validateProposedDAG([])
    expect(result.valid).toBe(true)
  })
})
