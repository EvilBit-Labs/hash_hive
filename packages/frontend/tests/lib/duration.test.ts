import { describe, expect, it } from 'bun:test'

import { formatDuration } from '../../src/lib/duration'

describe('formatDuration', () => {
  it('returns "--" for non-finite values', () => {
    expect(formatDuration(Number.NaN)).toBe('--')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('--')
    expect(formatDuration(0)).toBe('--')
    expect(formatDuration(-5)).toBe('--')
  })

  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(12)).toBe('12s')
    expect(formatDuration(29)).toBe('29s')
  })

  it('formats sub-hour durations in minutes', () => {
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(300)).toBe('5m')
    expect(formatDuration(59 * 60)).toBe('59m')
  })

  it('formats multi-hour durations with hours + minutes', () => {
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe('2h 15m')
    expect(formatDuration(3600)).toBe('1h')
  })

  it('formats multi-day durations in days + hours', () => {
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2d 3h')
    expect(formatDuration(86400)).toBe('1d')
  })

  it('rounds the minute portion correctly', () => {
    // 1h 14m 35s → rounds to 1h 15m
    expect(formatDuration(3600 + 14 * 60 + 35)).toBe('1h 15m')
  })
})
