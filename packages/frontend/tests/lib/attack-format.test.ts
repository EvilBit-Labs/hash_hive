import { describe, expect, it } from 'bun:test'

import { formatAttackEta, formatAttackKeyspace } from '../../src/lib/attack-format'

describe('formatAttackKeyspace', () => {
  it('returns null for a null keyspace (caller picks the empty state)', () => {
    expect(formatAttackKeyspace(null)).toBeNull()
  })

  it('groups digits below a million', () => {
    expect(formatAttackKeyspace('1000')).toBe((1000).toLocaleString())
  })

  it('uses scientific notation at or above a million', () => {
    expect(formatAttackKeyspace('1000000')).toBe('1.00e+6')
  })

  it('keeps mask-scale keyspaces compact', () => {
    // ~5.4e23 (?a^12-scale) — far past 2^53, formatted from the decimal string.
    expect(formatAttackKeyspace('540000000000000000000000')).toBe('5.40e+23')
  })
})

describe('formatAttackEta', () => {
  it('returns null for a null ETA', () => {
    expect(formatAttackEta(null)).toBeNull()
  })

  it('renders 0 seconds remaining as 0s (a finished attack), not null', () => {
    expect(formatAttackEta(0)).toBe('0s')
  })

  it('formats a minutes/hours duration', () => {
    expect(formatAttackEta(12000)).toBe('3h 20m') // 12000s = 3h20m
  })

  it('accepts the bigint-safe string form', () => {
    expect(formatAttackEta('90')).toBe('2m') // formatDuration rounds to nearest minute
  })

  it('clamps astronomical estimates to > 1 year', () => {
    expect(formatAttackEta('99999999999')).toBe('> 1 year')
  })

  it('returns null for a negative or non-finite value', () => {
    expect(formatAttackEta(-5)).toBeNull()
  })
})
