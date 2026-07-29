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
  // Audit log retention sweep (U9). Scheduled daily: deletes audit_logs rows
  // older than AUDIT_LOG_RETENTION in bounded batches to avoid table-lock
  // contention on large purges. Covers orphaned rows (project_id IS NULL).
  AUDIT_RETENTION: 'jobs-audit-retention',
  // Pre-cracked import propagation (issue #102, U7). Event-driven: enqueued
  // when a user submits a pre-cracked import file via the dashboard (U8).
  // Reads staged pairs from the object store (KTD3), upserts the target
  // hash list with provenance (KTD2), audits the write (KTD9), then
  // propagates each plaintext within the owning project via propagateCrack (U2/KTD4).
  // Deduped per import via a deterministic jobId built from hashListId +
  // staging key; QueueManager auto-pairs with removeOnComplete/removeOnFail.
  HASH_IMPORT_PROPAGATION: 'jobs-hash-import-propagation',
  // Blob-reclamation sweep (issue #106 U11). Scheduled daily: reclaims the
  // object-store blob (not the row) of word/rule/mask list resources
  // archived past BLOB_RECLAMATION_RETENTION, closing the restore-vs-sweep
  // race with an atomic intent-stamp before any deleteFile call.
  BLOB_RECLAMATION: 'jobs-blob-reclamation',
  // Chunked-upload compression (issue #108 U4). Event-driven: enqueued at
  // the end of a normal (non-restore) chunked-upload completion for a
  // word/rule/mask list, deduped per resource via a deterministic jobId.
  // Streams the just-completed object exactly once to compress it (when
  // that actually shrinks it) and capture the authoritative raw-file
  // checksum -- chunked uploads never buffer the whole file server-side, so
  // this background pass is the only place either can happen for files too
  // large for the direct-upload path's inline compression (U3).
  RESOURCE_COMPRESSION: 'jobs-resource-compression',
  // Mixed hash-list split analysis (issue #202 SU2/SU7). Partitions a mixed
  // hash list's hash_items into per-type sub-lists
  // (hash_lists.parent_hash_list_id) — one per confident hashcat mode, one
  // per ambiguous candidate-mode signature, one for unidentified entries —
  // and moves the rows. As of SU7, `services/campaign-split.ts`'s
  // `createCampaignOrSplit` enqueues a job on this queue (deduped per hash
  // list via `splitJobId`, jobId `split-<hashListId>`) instead of awaiting
  // `runSplitAnalysis` inline; `queue/workers/hash-list-split.ts`'s worker
  // processes it and returns the `SplitResult` as the job's returnvalue.
  // No dedicated `hash_lists.status` value: "split in progress" is read off
  // the job's own BullMQ lifecycle via `QueueManager.getJobInfo`
  // (`services/campaign-split-status.ts`'s `GET /campaigns/split/status`),
  // and idempotency is guarded by whether the parent already has children
  // (see runSplitAnalysis) regardless of how it's invoked.
  HASH_LIST_SPLIT: 'jobs-hash-list-split',
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
