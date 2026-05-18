import type { Job, Worker } from 'bullmq';
import { logger } from '../../config/logger.js';

type JobTiming = Pick<Job, 'processedOn' | 'finishedOn'>;

/**
 * Compute job processing duration in milliseconds for worker metrics logging.
 *
 * BullMQ sets `processedOn` when a worker picks up a job and `finishedOn`
 * when it resolves or rejects. Both fields must be present for a meaningful
 * duration; if either is missing (e.g. when a `failed` handler fires before
 * `processedOn` is set, or before BullMQ has stamped `finishedOn`), the
 * function returns 0. Returning 0 rather than wall-clock-since-pickup
 * prevents `failed`-without-`finishedOn` from logging an inflated duration
 * that conflates real processing time with elapsed time since pickup, and
 * keeps the payload numeric and JSON-clean.
 */
export function computeJobDurationMs(job: JobTiming | undefined | null): number {
  if (!job) return 0;
  if (typeof job.processedOn !== 'number' || typeof job.finishedOn !== 'number') return 0;
  const ms = job.finishedOn - job.processedOn;
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/**
 * Attach `completed` and `failed` event listeners to a BullMQ worker that
 * emit structured "Job completed" / "Job failed" log lines carrying
 * `jobId`, `queue`, `durationMs`, and (on success) the job result. The
 * `extractContext` callback lets each worker contribute its own typed
 * payload fields (e.g. `hashListId`, `campaignId`) without re-creating the
 * surrounding log shape four times.
 *
 * Implements AC #4 ("workers log job processing metrics — duration,
 * success/failure") from the BullMQ Queue Architecture spec.
 */
export function attachWorkerMetrics<DataT, ResultT, ContextT extends Record<string, unknown>>(
  worker: Worker<DataT, ResultT>,
  options: {
    queueName: string;
    failureMessage: string;
    extractContext?: (job: Job<DataT, ResultT> | undefined) => ContextT;
  }
): void {
  const buildContext = (job: Job<DataT, ResultT> | undefined): ContextT | Record<string, never> =>
    options.extractContext?.(job) ?? {};

  worker.on('completed', (job, result) => {
    logger.info(
      {
        jobId: job.id,
        queue: options.queueName,
        ...buildContext(job),
        durationMs: computeJobDurationMs(job),
        result,
      },
      'Job completed'
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      {
        jobId: job?.id,
        queue: options.queueName,
        ...buildContext(job),
        durationMs: computeJobDurationMs(job),
        err,
      },
      options.failureMessage
    );
  });
}
