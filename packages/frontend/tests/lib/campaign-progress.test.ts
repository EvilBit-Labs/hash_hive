import { describe, expect, it } from 'bun:test'

import { readCampaignPercentage, readTaskPercentage } from '../../src/lib/campaign-progress'

describe('readCampaignPercentage', () => {
  it('returns 0 for null', () => {
    expect(readCampaignPercentage(null)).toBe(0)
  })

  it('returns 0 for a non-object', () => {
    expect(readCampaignPercentage(42)).toBe(0)
    expect(readCampaignPercentage('half')).toBe(0)
  })

  it('returns 0 when no recognized key is present', () => {
    expect(readCampaignPercentage({ foo: 1, bar: 2 })).toBe(0)
  })

  it('prefers top-level percentage over overallProgress', () => {
    expect(readCampaignPercentage({ percentage: 0.75, overallProgress: 0.5 })).toBe(0.75)
  })

  it('falls back to overallProgress when percentage is missing', () => {
    expect(readCampaignPercentage({ overallProgress: 0.42 })).toBe(0.42)
  })

  it('falls back to hashProgress.percentage last', () => {
    expect(readCampaignPercentage({ hashProgress: { percentage: 0.33 } })).toBe(0.33)
  })
})

describe('readTaskPercentage', () => {
  it('returns 0 for null', () => {
    expect(readTaskPercentage(null)).toBe(0)
  })

  it('returns the explicit percentage when present', () => {
    expect(readTaskPercentage({ percentage: 0.5 })).toBe(0.5)
  })

  it('divides keyspaceProgress by total when both are present', () => {
    expect(readTaskPercentage({ keyspaceProgress: 500, total: 1000 })).toBe(0.5)
    expect(readTaskPercentage({ keyspaceProgress: 250, total: 1000 })).toBe(0.25)
  })

  it('returns 0 when total is zero (avoids divide-by-zero)', () => {
    expect(readTaskPercentage({ keyspaceProgress: 500, total: 0 })).toBe(0)
  })

  it('returns 0 when only one of keyspaceProgress / total is present', () => {
    expect(readTaskPercentage({ keyspaceProgress: 500 })).toBe(0)
    expect(readTaskPercentage({ total: 1000 })).toBe(0)
  })
})
