/**
 * Unit tests for the pure EWMA helper (U6).
 *
 * `computeEwma` is the formula behind the atomic SQL update in
 * `updateAgentObservedRate`; testing it in isolation documents the
 * smoothing behaviour without needing a database.
 */

import { describe, expect, it } from 'bun:test'

import { computeEwma } from '../../../src/services/agent-rate.js'

const ALPHA = 0.125 // the TCP SRTT value, the project default

describe('computeEwma', () => {
  it('converges toward a steady sample within ~15 steps', () => {
    const target = 1_000_000
    let ewma = 0
    for (let i = 0; i < 15; i++) {
      ewma = computeEwma(target, ewma, ALPHA)
    }
    // After ~15 samples at alpha=0.125 the EWMA is within ~15% of the target.
    expect(ewma).toBeGreaterThan(target * 0.85)
    expect(ewma).toBeLessThanOrEqual(target)
  })

  it('moves by roughly alpha on a single outlier, not to the outlier', () => {
    const prev = 1_000_000
    const outlier = 2_000_000
    const next = computeEwma(outlier, prev, ALPHA)
    // alpha*outlier + (1-alpha)*prev = 0.125*2e6 + 0.875*1e6 = 1,125,000
    expect(next).toBe(1_125_000)
    // Nowhere near the outlier.
    expect(next).toBeLessThan(prev + (outlier - prev) * 0.25)
  })

  it('returns an integer suitable for the bigint column', () => {
    const result = computeEwma(1_000_001, 1_000_000, ALPHA)
    expect(Number.isInteger(result)).toBe(true)
  })

  it('seeds from prev on the first step (prev acts as the seed)', () => {
    // When prev is the registration benchmark, one sample nudges it by alpha.
    const seed = 800_000
    const sample = 900_000
    expect(computeEwma(sample, seed, ALPHA)).toBe(Math.round(0.125 * sample + 0.875 * seed))
  })
})
