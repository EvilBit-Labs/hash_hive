import { useEffect, useRef, useState } from 'react'

/**
 * Branded monotonic-ms type. Minted only by `useSparkHistory` via
 * `performance.now()` + tiebreak — never equal to wall-clock `Date.now()`.
 * Carrying the brand at the type level prevents callers from mixing the two
 * time domains (the recurring footgun) and makes the unit visible at call
 * sites that read or compare timestamps.
 */
export type MonotonicMs = number & { readonly __brand: 'MonotonicMs' }

export interface SparkPoint {
  readonly sampledAtMs: MonotonicMs
  readonly value: number
}

const DEFAULT_CAPACITY = 20

/**
 * Client-side ring buffer of recent metric samples keyed by `key`.
 *
 * Returns the underlying buffer array directly — the reference is **stable
 * until the buffer mutates** and changes only when an append, key change, or
 * capacity shrink replaces it. Consumers can rely on this for `useMemo`
 * dependencies and Recharts data-prop reference checks.
 *
 * - Appends when `value` is a finite number and differs from the buffer's tail.
 * - Drops the oldest entries when the buffer exceeds `capacity` (including
 *   when `capacity` decreases between renders, not only on append).
 * - Clears the buffer entirely when `key` changes (no cross-key contamination).
 *
 * `sampledAtMs` ids are strictly monotonic per buffer and stable across
 * renders. The hook is the sole producer of `MonotonicMs`; callers cannot
 * mint one.
 */
export function useSparkHistory(
  key: string,
  value: number | undefined,
  capacity: number = DEFAULT_CAPACITY
): ReadonlyArray<SparkPoint> {
  const bufferRef = useRef<SparkPoint[]>([])
  const keyRef = useRef<string>(key)
  const lastSampledAtRef = useRef<number>(0)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let mutated = false

    if (keyRef.current !== key) {
      keyRef.current = key
      bufferRef.current = []
      lastSampledAtRef.current = 0
      mutated = true
    }

    // Honor capacity shrink even when no append fires this render.
    if (bufferRef.current.length > capacity) {
      bufferRef.current = bufferRef.current.slice(-capacity)
      mutated = true
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      const tail = bufferRef.current[bufferRef.current.length - 1]
      if (!tail || tail.value !== value) {
        // Guarantee strictly monotonic ids even if performance.now() returns
        // a value equal to the previous (rare but possible on hot loops).
        const now = performance.now()
        const sampledAtMs = (
          now > lastSampledAtRef.current ? now : lastSampledAtRef.current + 1
        ) as MonotonicMs
        lastSampledAtRef.current = sampledAtMs
        const next = [...bufferRef.current, { sampledAtMs, value }]
        bufferRef.current = next.length > capacity ? next.slice(-capacity) : next
        mutated = true
      }
    }

    if (mutated) {
      setRevision((r) => r + 1)
    }
    // No cleanup: the effect only mutates refs + a state setter, no
    // subscriptions, timers, or external resources to release.
  }, [key, value, capacity])

  // Subscribe to revision so the render invalidates when the buffer mutates.
  // The returned reference stays stable across renders that do not mutate.
  void revision
  return bufferRef.current
}
