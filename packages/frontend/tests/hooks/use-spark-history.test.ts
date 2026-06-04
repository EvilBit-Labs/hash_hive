import { afterEach, describe, expect, it } from 'bun:test'

import { useSparkHistory } from '../../src/hooks/use-spark-history'
import { cleanupAll, renderHook } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('useSparkHistory', () => {
  it('appends successive distinct values for the same key', () => {
    const { result, rerender } = renderHook(
      ({ key, value }: { key: string; value: number | undefined }) => useSparkHistory(key, value),
      { initialProps: { key: 'agents', value: 1 } }
    )
    expect(result.current.map((p) => p.value)).toEqual([1])
    rerender({ key: 'agents', value: 2 })
    expect(result.current.map((p) => p.value)).toEqual([1, 2])
    rerender({ key: 'agents', value: 3 })
    expect(result.current.map((p) => p.value)).toEqual([1, 2, 3])
  })

  it('caps to capacity, dropping the oldest', () => {
    const capacity = 5
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useSparkHistory('agents', value, capacity),
      { initialProps: { value: 1 } }
    )
    for (let v = 2; v <= 10; v++) {
      rerender({ value: v })
    }
    const values = result.current.map((p) => p.value)
    expect(values).toEqual([6, 7, 8, 9, 10])
    expect(values).toHaveLength(capacity)
  })

  it('preserves stable monotonic sampledAt ids across renders', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useSparkHistory('agents', value),
      { initialProps: { value: 1 } }
    )
    rerender({ value: 2 })
    rerender({ value: 3 })
    const first = result.current
    // Re-render with same value (no append) — existing ids must not be re-stamped
    rerender({ value: 3 })
    const second = result.current
    expect(second.map((p) => p.sampledAt)).toEqual(first.map((p) => p.sampledAt))
    // sampledAt is strictly increasing
    const ids = first.map((p) => p.sampledAt)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0)
    }
  })

  it('clears the buffer when the key changes', () => {
    const { result, rerender } = renderHook(
      ({ key, value }: { key: string; value: number }) => useSparkHistory(key, value),
      { initialProps: { key: 'agents', value: 1 } }
    )
    rerender({ key: 'agents', value: 2 })
    rerender({ key: 'agents', value: 3 })
    expect(result.current).toHaveLength(3)
    rerender({ key: 'campaigns', value: 5 })
    expect(result.current.map((p) => p.value)).toEqual([5])
  })

  it('ignores undefined / NaN / non-finite values', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number | undefined }) => useSparkHistory('agents', value),
      { initialProps: { value: undefined } }
    )
    expect(result.current).toEqual([])
    rerender({ value: Number.NaN })
    expect(result.current).toEqual([])
    rerender({ value: Number.POSITIVE_INFINITY })
    expect(result.current).toEqual([])
    rerender({ value: 7 })
    expect(result.current.map((p) => p.value)).toEqual([7])
  })

  it('suppresses duplicate consecutive values', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useSparkHistory('agents', value),
      { initialProps: { value: 5 } }
    )
    rerender({ value: 5 })
    rerender({ value: 5 })
    expect(result.current.map((p) => p.value)).toEqual([5])
    rerender({ value: 6 })
    expect(result.current.map((p) => p.value)).toEqual([5, 6])
  })

  it('key change resets buffer even when numeric value is identical', () => {
    const { result, rerender } = renderHook(
      ({ key, value }: { key: string; value: number }) => useSparkHistory(key, value),
      { initialProps: { key: 'project-1:agents', value: 5 } }
    )
    rerender({ key: 'project-1:agents', value: 7 })
    expect(result.current).toHaveLength(2)
    // Switch project — same numeric value, different key
    rerender({ key: 'project-2:agents', value: 7 })
    expect(result.current.map((p) => p.value)).toEqual([7])
  })
})
