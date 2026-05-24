/**
 * Single source of truth for reading a normalized progress percentage
 * from a campaign or task `progress` jsonb payload. The backend's
 * envelope is loose — different writers (campaign aggregator, task
 * progress reports, agent heartbeats) populate different keys — so
 * the reader checks the known fields in order of preference and
 * returns a number in `[0, 1]` (canonical fraction scale) or a number
 * in `[0, 100]` if the source value used the percentage scale. The
 * downstream `ProgressBar` clamps and normalizes either way.
 *
 * Returns `0` when no recognized key is found. Logging a console
 * warning on that fallback is the caller's choice; this helper stays
 * pure so it can run in test environments and Suspense boundaries.
 */

interface ProgressKeyspaceShape {
  keyspaceProgress?: number
  total?: number
}

interface CampaignProgressShape {
  percentage?: number
  overallProgress?: number
  hashProgress?: { percentage?: number }
}

/**
 * Read a percentage from a campaign-level progress payload. The
 * campaign aggregator emits `percentage` (canonical 0..1), and earlier
 * code paths produced `overallProgress`; the `hashProgress.percentage`
 * sub-field is the cracked-hashes ratio. Order of preference reflects
 * which value is the most authoritative when multiple are present.
 */
export function readCampaignPercentage(progress: unknown): number {
  if (!progress || typeof progress !== 'object') return 0
  const p = progress as CampaignProgressShape
  if (typeof p.percentage === 'number') return p.percentage
  if (typeof p.overallProgress === 'number') return p.overallProgress
  if (typeof p.hashProgress?.percentage === 'number') return p.hashProgress.percentage
  return 0
}

/**
 * Read a percentage from a task-level progress payload. Tasks report
 * either `percentage` directly or a keyspace-progress / total pair
 * that the helper divides to produce a fraction in `[0, 1]`.
 */
export function readTaskPercentage(progress: unknown): number {
  if (!progress || typeof progress !== 'object') return 0
  const p = progress as CampaignProgressShape & ProgressKeyspaceShape
  if (typeof p.percentage === 'number') return p.percentage
  if (typeof p.keyspaceProgress === 'number' && typeof p.total === 'number' && p.total > 0) {
    return p.keyspaceProgress / p.total
  }
  return 0
}
