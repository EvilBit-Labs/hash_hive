/**
 * Campaign progress aggregation + auto-completion.
 *
 * Extracted from `services/campaigns.ts` to keep that module under the
 * 800-line guideline. Includes:
 *   - `shouldAutoCompleteCampaign` — pure guard for the auto-transition.
 *   - `computeCampaignEta` — pure ETA estimator.
 *   - `updateCampaignProgress` — SQL aggregation + cached progress write.
 *
 * Imports `transitionCampaign` dynamically from `./campaigns.js` to
 * break the static cycle (campaigns.ts re-exports this module).
 */
import { campaigns, tasks } from '@hashhive/shared';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { getHashListStats } from './resources.js';

/**
 * Pure decision: should a campaign auto-transition to `completed`?
 *
 * Triggered when the campaign is in a status that still has
 * outstanding tasks (`running` or `paused`) AND every task has
 * reached a terminal state (completed/exhausted/failed). The paused
 * case matters because a campaign whose last tasks finish during a
 * pause has no other trigger that would move it forward — without
 * this, the campaign would stay 'paused' indefinitely.
 *
 * Returns false for terminal statuses (completed, cancelled) to avoid
 * recursion, and for draft (no tasks to finish yet).
 *
 * Exported for unit testing the guard without mocking SQL.
 */
export function shouldAutoCompleteCampaign(input: {
  status: string;
  totalTasks: number;
  completedCount: number;
  failedCount: number;
}): boolean {
  if (input.status !== 'running' && input.status !== 'paused') return false;
  if (input.totalTasks <= 0) return false;
  return input.completedCount + input.failedCount >= input.totalTasks;
}

/**
 * Pure ETA estimator: project remaining-work completion from average
 * throughput since campaign start. Returns `null` when there's no
 * throughput basis (no running tasks, no startedAt, elapsed < 1s, no
 * measurable progress, or no remaining work). Exported for unit
 * testing the rate math without mocking SQL.
 */
export function computeCampaignEta(input: {
  startedAt: Date | null;
  now: Date;
  totalTasks: number;
  completedCount: number;
  failedCount: number;
  runningProgress: number;
  runningTaskCount: number;
}): string | null {
  if (input.runningTaskCount <= 0) return null;
  if (!input.startedAt) return null;
  const completedFraction = input.completedCount + input.runningProgress;
  if (completedFraction <= 0) return null;
  const elapsedMs = input.now.getTime() - input.startedAt.getTime();
  if (elapsedMs < 1000) return null;
  const rate = completedFraction / (elapsedMs / 1000); // tasks per second
  const remaining = Math.max(0, input.totalTasks - completedFraction - input.failedCount);
  if (rate <= 0 || remaining <= 0) return null;
  return new Date(input.now.getTime() + (remaining / rate) * 1000).toISOString();
}

// Dynamic-import getter for transitionCampaign — breaks the static
// cycle with services/campaigns.ts (which re-exports this module).
// Tests can swap this to a stub. Module-level import would create an
// unresolvable cycle at evaluation time.
export const _progressDeps = {
  getTransitionCampaign: async () => {
    const mod = await import('./campaigns.js');
    return mod.transitionCampaign;
  },
};

export async function updateCampaignProgress(campaignId: number): Promise<void> {
  // Single aggregation query: total tasks, terminal counts, clamped running progress.
  //
  // `progress.keyspaceProgress` is the agent-reported count of keyspace units
  // already cracked within a task's `workRange.total`. We divide to get a
  // fraction in [0, 1] (LEAST clamps reports that overrun the chunk to 1.0),
  // then SUM the fractions across running tasks for the campaign's running
  // contribution. The earlier `LEAST(keyspaceProgress, 1)` formulation
  // misread the field as already-a-fraction; the spec at
  // docs/issues/96-keyspace-task-distribution-spec.md is the contract.
  const [agg] = await db
    .select({
      totalTasks: sql<number>`count(*)`,
      completedCount: sql<number>`count(*) FILTER (WHERE ${tasks.status} IN ('completed', 'exhausted'))`,
      failedCount: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'failed')`,
      // CASE WHEN guards the divide-by-zero case explicitly: a placeholder
      // task created without a real keyspace has `workRange.total = 0`, and
      // letting that flow into the division produces NULL, which
      // `LEAST(NULL, 1) = 1` would silently count as a 100%-complete task.
      // Default to 0 progress for any task with total <= 0.
      //
      // Use ::numeric (arbitrary-precision) instead of ::float for the
      // division: mask-attack keyspaces routinely exceed 2^53 - 1, and
      // ::float would round large numerators / denominators to the
      // nearest 64-bit double - a near-complete task could appear as
      // 1.0 long before the agent actually finished. We cast back to
      // double precision at the outermost boundary so the result still
      // fits the `runningProgress: number` JS field.
      runningProgress: sql<number>`(COALESCE(
        SUM(
          CASE
            WHEN COALESCE((${tasks.workRange}->>'total')::numeric, 0) > 0 THEN
              GREATEST(
                0::numeric,
                LEAST(
                  COALESCE((${tasks.progress}->>'keyspaceProgress')::numeric, 0)
                    / (${tasks.workRange}->>'total')::numeric,
                  1::numeric
                )
              )
            ELSE 0::numeric
          END
        ) FILTER (WHERE ${tasks.status} = 'running'),
        0::numeric
      ))::double precision`,
      runningTaskCount: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'running')`,
    })
    .from(tasks)
    .where(eq(tasks.campaignId, campaignId));

  const totalTasks = agg?.totalTasks ?? 0;
  if (totalTasks === 0) return;

  const completedCount = agg?.completedCount ?? 0;
  const failedCount = agg?.failedCount ?? 0;
  const runningProgress = agg?.runningProgress ?? 0;
  const runningTaskCount = agg?.runningTaskCount ?? 0;

  const overallProgress = (completedCount + runningProgress) / totalTasks;

  // Hash-based progress + ETA reference: load campaign metadata once.
  const [campaign] = await db
    .select({
      hashListId: campaigns.hashListId,
      status: campaigns.status,
      projectId: campaigns.projectId,
      startedAt: campaigns.startedAt,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  let hashProgress: {
    total: number;
    cracked: number;
    remaining: number;
    percentage: number;
  } | null = null;

  if (campaign?.hashListId) {
    const stats = await getHashListStats(campaign.hashListId);

    if (stats.total > 0) {
      hashProgress = {
        ...stats,
        percentage: Math.round((stats.cracked / stats.total) * 10000) / 10000,
      };
    }
  }

  // ETA: project completion from the average rate since campaign start.
  // Estimate driven by task-completion velocity — the dashboard treats
  // it as a forecast, not a guarantee. See `computeCampaignEta` for the
  // null-handling rules.
  const eta = computeCampaignEta({
    startedAt: campaign?.startedAt ?? null,
    now: new Date(),
    totalTasks,
    completedCount,
    failedCount,
    runningProgress,
    runningTaskCount,
  });

  await db
    .update(campaigns)
    .set({
      progress: {
        totalTasks,
        completedTasks: completedCount,
        tasksFailed: failedCount,
        eta,
        overallProgress: Math.round(overallProgress * 10000) / 10000,
        updatedAt: new Date().toISOString(),
        ...(hashProgress ? { hashProgress } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, campaignId));

  // Auto-transition running → completed when every task has reached a
  // terminal state (completed/exhausted/failed). Guarded so we don't
  // fight a manual stop or recurse on an already-completed campaign.
  // transitionCampaign emits the `campaign_status` event and stamps
  // `completedAt` — we don't duplicate either here.
  //
  // Failure handling: this function is on the task-report hot path
  // (tasks.ts:updateTaskProgress). If the auto-transition throws (DB
  // blip, queue glitch), an unwrapped throw would 500 the agent's
  // `/tasks/:id/report` call *after* the task row was already
  // persisted, leaving the agent to retry against a "task already
  // completed" error and never recover. Treat the auto-transition as
  // best-effort: log and swallow. The next task-status write will
  // re-evaluate the gate and retry.
  if (
    campaign &&
    shouldAutoCompleteCampaign({
      status: campaign.status,
      totalTasks,
      completedCount,
      failedCount,
    })
  ) {
    try {
      const transitionCampaign = await _progressDeps.getTransitionCampaign();
      await transitionCampaign(campaignId, 'completed');
    } catch (err) {
      logger.error(
        { err, campaignId, totalTasks, completedCount, failedCount },
        'auto-complete transitionCampaign threw; leaving for next progress write to retry'
      );
    }
  }
}
