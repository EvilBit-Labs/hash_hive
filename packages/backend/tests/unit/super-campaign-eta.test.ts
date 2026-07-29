/**
 * Unit tests for `computeSuperCriticalPathEta` (issue #101 U11, axis b) — the
 * pure state-combination logic that rolls a super PARENT campaign's ETA up from
 * its sub-campaign ETAs as the CRITICAL PATH (max), never an average.
 *
 * This is the adversarial-F6 guarantee in isolation: a fast sub near completion
 * can NEVER drag the super's reported finish earlier than the slowest sub still
 * lagging. No DB — every combination is exercised directly against the function.
 */

import type { CampaignEta } from '@hashhive/shared'

import { describe, expect, it } from 'bun:test'

import {
  computeSuperCriticalPathEta,
  deriveSuperDone,
} from '../../src/services/super-campaign-progress.js'

const ready = (seconds: number): CampaignEta => ({ state: 'ready', seconds })
const lowerBound = (seconds: number, pendingAttacks = 1): CampaignEta => ({
  state: 'lower_bound',
  seconds,
  pendingAttacks,
})
const estimating: CampaignEta = { state: 'estimating' }
const paused: CampaignEta = { state: 'paused' }
const noAgents: CampaignEta = { state: 'no_agents' }
const complete: CampaignEta = { state: 'complete' }

describe('computeSuperCriticalPathEta — empty / all-complete', () => {
  it('no sub-campaigns → complete (a super with nothing to run is done)', () => {
    expect(computeSuperCriticalPathEta([])).toEqual({ state: 'complete' })
  })

  it('every sub complete → complete', () => {
    expect(computeSuperCriticalPathEta([complete, complete])).toEqual({ state: 'complete' })
  })
})

describe('computeSuperCriticalPathEta — critical path is MAX, not average', () => {
  it('reports the SLOWEST sub, not the mean (90%-done fast + 10%-done slow ≠ 50%)', () => {
    // Fast sub finishes in 60s, slow sub in 3600s. The honest wall-clock is the
    // slow one — an average (1830s) would understate it.
    const result = computeSuperCriticalPathEta([ready(60), ready(3600)])
    expect(result).toEqual({ state: 'ready', seconds: 3600 })
  })

  it('a completed sub drops out of the critical path entirely', () => {
    // complete = zero remaining, so the MAX is over the active subs only.
    const result = computeSuperCriticalPathEta([complete, ready(120)])
    expect(result).toEqual({ state: 'ready', seconds: 120 })
  })

  it('all-ready → ready with the max seconds', () => {
    expect(computeSuperCriticalPathEta([ready(10), ready(500), ready(50)])).toEqual({
      state: 'ready',
      seconds: 500,
    })
  })
})

describe('computeSuperCriticalPathEta — non-progressing states dominate', () => {
  it('a paused active sub → paused (the potentially-slowest work is not moving)', () => {
    expect(computeSuperCriticalPathEta([ready(3600), paused])).toEqual({ state: 'paused' })
  })

  it('a no_agents active sub → no_agents', () => {
    expect(computeSuperCriticalPathEta([ready(3600), noAgents])).toEqual({ state: 'no_agents' })
  })

  it('paused precedes no_agents when both present (mirrors single-campaign ladder)', () => {
    expect(computeSuperCriticalPathEta([paused, noAgents, ready(10)])).toEqual({ state: 'paused' })
  })

  it('a completed paused-nowhere sub does not force paused — only ACTIVE subs count', () => {
    // `complete` filtered out first; remaining active sub is a clean ready.
    expect(computeSuperCriticalPathEta([complete, ready(42)])).toEqual({
      state: 'ready',
      seconds: 42,
    })
  })
})

describe('computeSuperCriticalPathEta — estimating / lower_bound propagate uncertainty', () => {
  it('every active sub estimating → estimating (nothing resolved to a number yet)', () => {
    expect(computeSuperCriticalPathEta([estimating, estimating])).toEqual({ state: 'estimating' })
  })

  it('a resolved sub alongside an estimating sub → lower_bound (the floor could rise)', () => {
    const result = computeSuperCriticalPathEta([ready(300), estimating])
    expect(result).toEqual({ state: 'lower_bound', seconds: 300, pendingAttacks: 1 })
  })

  it('a lower_bound sub keeps the super-wide max a floor even when it is the max', () => {
    const result = computeSuperCriticalPathEta([ready(100), lowerBound(900)])
    expect(result).toEqual({ state: 'lower_bound', seconds: 900, pendingAttacks: 1 })
  })

  it('counts every not-fully-resolved active sub in pendingAttacks', () => {
    const result = computeSuperCriticalPathEta([ready(50), estimating, lowerBound(80)])
    expect(result).toEqual({ state: 'lower_bound', seconds: 80, pendingAttacks: 2 })
  })

  it('a paused sub still dominates an otherwise lower_bound rollup', () => {
    expect(computeSuperCriticalPathEta([estimating, lowerBound(500), paused])).toEqual({
      state: 'paused',
    })
  })
})

describe('deriveSuperDone - agrees with eta, never contradicts it', () => {
  it('zero sub-campaigns -> done, matching computeSuperCriticalPathEta([]) === complete', () => {
    const eta = computeSuperCriticalPathEta([])
    expect(deriveSuperDone(0, 0, eta)).toBe(true)
  })

  it('non-empty subs, all completed -> done', () => {
    expect(deriveSuperDone(2, 2, complete)).toBe(true)
  })

  it('non-empty subs, some still running -> not done even if eta happens to read complete', () => {
    // Defends the "every sub complete" requirement independently of eta: a
    // caller passing a stale/mismatched eta must not flip `done` true just
    // because eta.state is complete.
    expect(deriveSuperDone(2, 1, complete)).toBe(false)
  })

  it('non-empty subs, none completed -> not done', () => {
    expect(deriveSuperDone(2, 0, ready(60))).toBe(false)
  })
})
