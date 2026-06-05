import { formatDistanceToNowStrict } from 'date-fns'
import { useEffect, useState } from 'react'

const SECOND_MS = 1_000

/**
 * Ticks every second and returns date-fns' strict "X ago" string for a
 * given timestamp. Re-renders happen at 1 Hz — scope this hook to small
 * leaf surfaces, not to a parent that wraps the whole dashboard tree.
 *
 * `formatDistanceToNowStrict` is the operator-correct variant: no
 * "about an hour ago" fuzzing, just concrete seconds / minutes / hours.
 * The `addSuffix: true` flag appends the locale-correct " ago".
 *
 * Returns `'never updated'` when the timestamp is null / 0 / undefined,
 * which is the React Query pre-fetch state. The pre-fetch state is
 * distinct from a stale post-fetch state (handled by the caller via the
 * connection indicator), so this hook does not encode "stale" vocabulary.
 */
export function useRelativeTime(updatedAtMs: number | null | undefined): string {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), SECOND_MS)
    return () => window.clearInterval(id)
  }, [])

  // `tick` is intentionally referenced so React rerenders this hook on
  // each interval fire; the value itself is opaque.
  void tick

  if (!updatedAtMs) return 'never updated'
  return formatDistanceToNowStrict(updatedAtMs, { addSuffix: true })
}
