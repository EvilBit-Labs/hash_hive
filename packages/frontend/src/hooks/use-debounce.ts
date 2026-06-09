import { useEffect, useState } from 'react'

/**
 * Returns a debounced copy of `value` that only updates after `delay`
 * milliseconds have elapsed without further changes. Used by the global
 * Results page filters (U7) so the free-text search input does not fire
 * a fresh `/dashboard/results` request on every keystroke.
 *
 * Per the project coding style this hook is immutable: it never mutates
 * the input, and the returned value is a fresh React state slot.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)
    return () => {
      clearTimeout(handle)
    }
  }, [value, delay])

  return debouncedValue
}
