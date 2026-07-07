import { describe, expect, it } from 'bun:test'

import type { CampaignActiveAgent, CampaignTaskStats } from '../../src/hooks/use-dashboard'

import { computeEta } from '../../src/lib/campaign-eta'

function makeAgent(speedHs: number | null): CampaignActiveAgent {
  return {
    agentId: 1,
    agentName: 'Rig',
    taskId: 1,
    attackId: 1,
    attackMode: 0,
    progress: null,
    speedHs,
  }
}

const ZERO_STATS: CampaignTaskStats = {
  total: 0,
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
}

describe('computeEta', () => {
  it('returns "--" when stats are null', () => {
    expect(computeEta(null, [])).toBe('--')
  })

  it('returns "--" when no tasks exist', () => {
    expect(computeEta(ZERO_STATS, [makeAgent(1000)])).toBe('--')
  })

  it('returns "--" when all tasks are completed/failed', () => {
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 0,
      running: 0,
      completed: 8,
      failed: 2,
    }
    expect(computeEta(stats, [makeAgent(1000)])).toBe('--')
  })

  it('returns "--" when no agent reports a positive speed', () => {
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 5,
      running: 0,
      completed: 5,
      failed: 0,
    }
    expect(computeEta(stats, [makeAgent(null), makeAgent(0)])).toBe('--')
  })

  it('returns "--" when agents array is empty even with remaining work', () => {
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 10,
      running: 0,
      completed: 0,
      failed: 0,
    }
    expect(computeEta(stats, [])).toBe('--')
  })

  it('returns a duration string when work and speed are non-trivial', () => {
    const stats: CampaignTaskStats = {
      total: 100,
      pending: 50,
      running: 50,
      completed: 0,
      failed: 0,
    }
    const result = computeEta(stats, [makeAgent(1000), makeAgent(2000)])
    expect(result).not.toBe('--')
    expect(typeof result).toBe('string')
  })

  it('pins the exact formatted output for a known-magnitude scenario', () => {
    // 100 remaining * 1e9 hashes/task = 1e11 hashes
    // aggregate speed = 1e9 H/s
    // remainingSeconds = 1e11 / 1e9 = 100s -> rounds to 2m
    const stats: CampaignTaskStats = {
      total: 100,
      pending: 100,
      running: 0,
      completed: 0,
      failed: 0,
    }
    const result = computeEta(stats, [makeAgent(500_000_000), makeAgent(500_000_000)])
    expect(result).toBe('2m')
  })

  it('returns "--" for impossible negative remaining (defensive against bucketing bugs)', () => {
    // total < completed + failed should never happen, but if a future
    // bucketing regression produces it, return -- instead of letting
    // negative durations leak through to formatDuration.
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 0,
      running: 0,
      completed: 8,
      failed: 5,
    }
    expect(computeEta(stats, [makeAgent(1000)])).toBe('--')
  })
})
