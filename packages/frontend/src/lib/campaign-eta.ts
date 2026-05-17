import type { CampaignActiveAgent, CampaignTaskStats } from '../hooks/use-dashboard';

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * Approximate the remaining time for a campaign from task counts and the
 * aggregate hash-rate of agents currently working on it. This is a
 * client-side estimate; the backend has no ETA model in v1.
 *
 * Approximation: `remaining tasks * avg-chunk-keyspace / aggregate-speed`.
 * The "avg chunk keyspace" is unknown client-side, so we substitute a
 * conservative proxy — assume each remaining task represents one
 * average-completion-time slot. If no agent reports a speed, return `--`.
 *
 * @returns "Nh Mm" / "Md Nh" / "Mm Ns" formatted estimate, or `'--'`
 *          when the inputs do not support a meaningful estimate.
 */
export function computeEta(
  stats: CampaignTaskStats | null | undefined,
  agents: ReadonlyArray<CampaignActiveAgent> | null | undefined
): string {
  if (!stats || stats.total === 0) return '--';

  const remaining = stats.total - stats.completed - stats.failed;
  if (remaining <= 0) return '--';

  const aggregateSpeed = (agents ?? []).reduce<number>((sum, agent) => {
    return sum + (typeof agent.speedHs === 'number' && agent.speedHs > 0 ? agent.speedHs : 0);
  }, 0);

  if (aggregateSpeed <= 0) return '--';

  // Use the average completed-task-rate as a coarse proxy for the per-task
  // wall-clock cost. When no completions exist yet, fall back to a flat
  // estimate of 1 task per second per active agent — enough to render
  // something rather than `--` once work is moving.
  const activeAgentCount = (agents ?? []).filter((a) => a.speedHs && a.speedHs > 0).length;
  const tasksPerSecond = Math.max(activeAgentCount / SECONDS_PER_MINUTE, 0.01);
  const remainingSeconds = remaining / tasksPerSecond;
  return formatDuration(remainingSeconds);
}

/**
 * Format a duration (seconds) as a compact human string. Rounds to the
 * nearest minute for durations under a day, and to the nearest hour for
 * longer durations.
 *
 * Exported for tests; callers should prefer `computeEta`.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '--';

  const totalMinutes = Math.round(totalSeconds / SECONDS_PER_MINUTE);
  if (totalMinutes < 1) {
    return `${Math.round(totalSeconds)}s`;
  }

  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes - totalHours * MINUTES_PER_HOUR;

  if (totalHours < HOURS_PER_DAY) {
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }

  const days = Math.floor(totalHours / HOURS_PER_DAY);
  const hours = totalHours - days * HOURS_PER_DAY;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
