const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

/**
 * Format a duration (seconds) as a compact human string. Rounds to the
 * nearest minute for durations under a day, and to the nearest hour for
 * longer durations. Returns `'--'` for non-finite or non-positive input.
 *
 * Shared by the per-attack ETA formatter (`formatAttackEta`) and the
 * campaign-level ETA display. Lives in its own module so it survives the
 * retirement of the client-side ETA proxy (`campaign-eta.ts`).
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '--'

  const totalMinutes = Math.round(totalSeconds / SECONDS_PER_MINUTE)
  if (totalMinutes < 1) {
    return `${Math.round(totalSeconds)}s`
  }

  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${totalMinutes}m`
  }

  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  const minutes = totalMinutes - totalHours * MINUTES_PER_HOUR

  if (totalHours < HOURS_PER_DAY) {
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`
  }

  const days = Math.floor(totalHours / HOURS_PER_DAY)
  const hours = totalHours - days * HOURS_PER_DAY
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}
