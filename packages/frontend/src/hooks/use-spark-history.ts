import { useEffect, useRef, useState } from 'react'

export interface SparkPoint {
  readonly sampledAt: number
  readonly value: number
}

const DEFAULT_CAPACITY = 20

/**
 * Client-side ring buffer of recent metric samples keyed by `key`.
 * Returns a fresh slice each render so consumers can rely on reference
 * equality for unchanged buffers and to invalidate memoized derivations
 * when the buffer mutates.
 *
 * - Appends when `value` is a finite number and differs from the buffer's tail.
 * - Drops the oldest entry once the buffer exceeds `capacity`.
 * - Clears the buffer entirely when `key` changes (no cross-key contamination).
 *
 * sampledAt ids are strictly monotonic per buffer and stable across renders.
 */
export function useSparkHistory(
  key: string,
  value: number | undefined,
  capacity: number = DEFAULT_CAPACITY
): SparkPoint[] {
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

    if (typeof value === 'number' && Number.isFinite(value)) {
      const tail = bufferRef.current[bufferRef.current.length - 1]
      if (!tail || tail.value !== value) {
        // Guarantee strictly monotonic ids even if performance.now() returns
        // a value equal to the previous (rare but possible on hot loops).
        const now = performance.now()
        const sampledAt = now > lastSampledAtRef.current ? now : lastSampledAtRef.current + 1
        lastSampledAtRef.current = sampledAt
        const next = [...bufferRef.current, { sampledAt, value }]
        bufferRef.current = next.length > capacity ? next.slice(-capacity) : next
        mutated = true
      }
    }

    if (mutated) {
      setRevision((r) => r + 1)
    }
  }, [key, value, capacity])

  // Read `revision` so this render is invalidated when the buffer mutates;
  // return a defensive slice so downstream identity comparisons work.
  void revision
  return bufferRef.current.slice()
}
