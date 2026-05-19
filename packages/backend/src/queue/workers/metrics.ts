import type { Job, Worker } from 'bullmq';
import { logger } from '../../config/logger.js';

type JobTiming = Pick<Job, 'processedOn' | 'finishedOn'>;

// Returns 0 (not wall-clock-since-pickup) if 'failed' fires before BullMQ stamps both timing fields.
export function computeJobDurationMs(job: JobTiming | undefined | null): number {
  if (!job) return 0;
  if (typeof job.processedOn !== 'number' || typeof job.finishedOn !== 'number') return 0;
  const ms = job.finishedOn - job.processedOn;
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

export function attachWorkerMetrics<DataT, ResultT>(
  worker: Worker<DataT, ResultT>,
  options: {
    queueName: string;
    failureMessage: string;
    extractContext?: (job: Job<DataT, ResultT> | undefined) => Record<string, unknown>;
  }
): void {
  // BullMQ surfaces listener rejections as uncaughtException — isolate the caller's throws.
  function safeContext(job: Job<DataT, ResultT> | undefined): Record<string, unknown> {
    if (!options.extractContext) return {};
    try {
      return options.extractContext(job);
    } catch (err) {
      logger.error(
        { err, queue: options.queueName, jobId: job?.id },
        'metrics extractContext threw — falling back to empty context'
      );
      return {};
    }
  }

  worker.on('completed', (job, result) => {
    // Context spread first so canonical fields win on key collision.
    logger.info(
      {
        ...safeContext(job),
        jobId: job.id,
        queue: options.queueName,
        durationMs: computeJobDurationMs(job),
        result,
      },
      'Job completed'
    );
  });

  worker.on('failed', (job, err) => {
    logger.error(
      {
        ...safeContext(job),
        jobId: job?.id,
        queue: options.queueName,
        durationMs: computeJobDurationMs(job),
        err,
      },
      options.failureMessage
    );
  });

  // Non-job errors (Redis flaps, stream parse errors) arrive here, not 'failed'; no listener = uncaughtException.
  worker.on('error', (err) => {
    logger.error({ err, queue: options.queueName }, 'Worker error (non-job)');
  });
}
