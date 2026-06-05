import { afterEach, describe, expect, it, mock } from 'bun:test'

import { useRelativeTime } from '../../src/hooks/use-relative-time'
import { cleanupAll, renderHook } from '../test-utils'

afterEach(cleanupAll)

describe('useRelativeTime', () => {
  it('returns "never updated" when timestamp is null', () => {
    const { result } = renderHook(() => useRelativeTime(null))
    expect(result.current).toBe('never updated')
  })

  it('returns "never updated" when timestamp is 0 (React Query pre-fetch)', () => {
    const { result } = renderHook(() => useRelativeTime(0))
    expect(result.current).toBe('never updated')
  })

  it('returns "never updated" when timestamp is undefined', () => {
    const { result } = renderHook(() => useRelativeTime(undefined))
    expect(result.current).toBe('never updated')
  })

  it('returns a date-fns-formatted "ago" string for a recent timestamp', () => {
    // Pin Date.now() to a deterministic moment so the relative string
    // doesn't drift with wall-clock skew between test setup and the
    // hook's first render. date-fns reads Date.now() internally, so a
    // mock on Date.now is sufficient.
    const nowMs = 1_700_000_000_000
    const originalNow = Date.now
    Date.now = mock(() => nowMs)
    try {
      const { result } = renderHook(() => useRelativeTime(nowMs - 30_000))
      // date-fns "Strict" omits the "about" / "almost" softeners and
      // pins to the closest unit; for 30s ago that's "30 seconds ago".
      expect(result.current).toBe('30 seconds ago')
    } finally {
      Date.now = originalNow
    }
  })

  it('formats minute-scale deltas with the minutes unit', () => {
    const nowMs = 1_700_000_000_000
    const originalNow = Date.now
    Date.now = mock(() => nowMs)
    try {
      const { result } = renderHook(() => useRelativeTime(nowMs - 5 * 60_000))
      expect(result.current).toBe('5 minutes ago')
    } finally {
      Date.now = originalNow
    }
  })
})
