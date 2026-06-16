export const QUEUE_NAMES = {
  // Priority task queues — task generation jobs routed by campaign priority
  TASKS_HIGH: 'tasks-high',
  TASKS_NORMAL: 'tasks-normal',
  TASKS_LOW: 'tasks-low',

  // Job queues — dedicated async processing, each with its own worker process
  HASH_LIST_PARSING: 'jobs-hash-list-parsing',
  TASK_GENERATION: 'jobs-task-generation',
  HEARTBEAT_MONITOR: 'jobs-heartbeat-monitor',
  HEALTH_MONITOR: 'jobs-health-monitor',
  // Task preemption evaluation (issue #97). Event-driven: enqueued on
  // campaign priority changes and lifecycle transitions, deduped per
  // project via a deterministic jobId.
  PREEMPTION: 'jobs-preemption',
  // Resource line counting (issue #99). Event-driven: enqueued when a
  // wordlist/rulelist becomes ready without an inline count (chunked upload)
  // or an attack references an uncounted resource; deduped per resource via a
  // deterministic jobId. Counts the file once, then recomputes keyspace for
  // every dependent attack.
  LINE_COUNT: 'jobs-line-count',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

// Shared so the queue manager's enqueue default and the workers' final-attempt
// branches stay coupled.
export const DEFAULT_JOB_ATTEMPTS = 3

/** The three priority-based task queues for task generation routing. */
export const TASK_PRIORITY_QUEUES = [
  QUEUE_NAMES.TASKS_HIGH,
  QUEUE_NAMES.TASKS_NORMAL,
  QUEUE_NAMES.TASKS_LOW,
] as const

export type TaskPriorityQueue = (typeof TASK_PRIORITY_QUEUES)[number]

/** Maps a campaign priority value (1 = high, 5 = normal, 10 = low) to the corresponding task queue. */
export function getTaskQueueForPriority(priority: number): TaskPriorityQueue {
  if (priority <= 1) return QUEUE_NAMES.TASKS_HIGH
  if (priority >= 10) return QUEUE_NAMES.TASKS_LOW
  return QUEUE_NAMES.TASKS_NORMAL
}
