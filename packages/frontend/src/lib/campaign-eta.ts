import type { CampaignActiveAgent, CampaignTaskStats } from '../hooks/use-dashboard'

import { formatDuration } from './duration'

/**
 * Hashes-per-task floor used by the client-side ETA approximation. The
 * dashboard does not have access to per-attack keyspace in this payload,
 * so we treat each remaining task as a fixed-size unit and divide by the
 * aggregate hash-rate. Tuned so the rendered ETA stays on the same order
 * of magnitude as observed completion cadence for typical chunked attacks
 * (~1B hashes per chunk at hashcat defaults). Underestimates short-mode
 * attacks and overestimates very long ones — acceptable for v1 since the
 * UI labels the value as a "~" approximation.
 */
const HASHES_PER_TASK_PROXY = 1_000_000_000

/**
 * Approximate the remaining time for a campaign from task counts and the
 * aggregate hash-rate of agents currently working on it. This is a
 * client-side estimate; the backend has no ETA model in v1.
 *
 * Formula: `(remaining tasks * HASHES_PER_TASK_PROXY) / aggregate H/s`.
 * If no agent reports a positive speed, return `--`.
 *
 * @returns "Nh Mm" / "Md Nh" / "Mm" formatted estimate, or `'--'`
 *          when the inputs do not support a meaningful estimate.
 */
export function computeEta(
  stats: CampaignTaskStats | null | undefined,
  agents: ReadonlyArray<CampaignActiveAgent> | null | undefined
): string {
  if (!stats || stats.total === 0) return '--'

  const remaining = stats.total - stats.completed - stats.failed
  if (remaining <= 0) return '--'

  const aggregateSpeed = (agents ?? []).reduce<number>((sum, agent) => {
    return sum + (typeof agent.speedHs === 'number' && agent.speedHs > 0 ? agent.speedHs : 0)
  }, 0)

  if (aggregateSpeed <= 0) return '--'

  const remainingHashes = remaining * HASHES_PER_TASK_PROXY
  const remainingSeconds = remainingHashes / aggregateSpeed
  return formatDuration(remainingSeconds)
}
