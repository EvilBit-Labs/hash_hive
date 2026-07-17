import type { QUEUE_NAMES } from '../config/queue.js'
import type { AuditActor } from '../services/audit-log.js'

// ─── Job Priority ────────────────────────────────────────────────────

export const JOB_PRIORITY = {
  HIGH: 1,
  NORMAL: 5,
  LOW: 10,
} as const

export type JobPriority = (typeof JOB_PRIORITY)[keyof typeof JOB_PRIORITY]

// ─── Job Payloads ────────────────────────────────────────────────────

export interface HashListParseJob {
  hashListId: number
  projectId: number
}

export interface TaskGenerationJob {
  campaignId: number
  projectId: number
  attackIds: number[]
  priority: JobPriority
}

export interface HeartbeatMonitorJob {
  triggeredAt: string
}

export interface HealthMonitorJob {
  triggeredAt: string
}

export interface PreemptionJob {
  projectId: number
}

export interface LineCountJob {
  // Wordlists/rulelists are sized by line count; a masklist is sized by its
  // summed mask keyspace (Σ per-line calculateMaskKeyspace), persisted to
  // mask_lists.keyspace (#231). All three fan out to dependent attacks.
  resourceType: 'wordlist' | 'rulelist' | 'masklist'
  resourceId: number
  projectId: number
}

export interface AuditRetentionJob {
  triggeredAt: string
}

export interface BlobReclamationJob {
  triggeredAt: string
}

/**
 * Payload for the chunked-upload compression worker (issue #108 U4).
 * `resourceType` mirrors `LineCountJob`'s discriminant -- word/rule/mask
 * lists only (hash lists have no `compression_encoding`/`file_checksum`
 * columns and never reach this queue).
 */
export interface ResourceCompressionJob {
  resourceType: 'wordlist' | 'rulelist' | 'masklist'
  resourceId: number
  projectId: number
}

/**
 * Payload for the mixed hash-list split analysis job (issue #202 SU2).
 *
 * `projectId` is carried for parity with the other resource-scoped job
 * payloads (log context, future event scoping) even though
 * `runSplitAnalysis` re-reads it from the parent row itself — never trust
 * a stale caller-supplied projectId for the actual DB write.
 */
export interface HashListSplitJob {
  hashListId: number
  projectId: number
}

/**
 * Payload for the hash import propagation job (U7).
 *
 * CRITICAL (KTD3): recovered plaintexts must NEVER appear in this payload.
 * The `stagingKey` is the S3/object-store key of the staged JSON file
 * (array of ParsedImportPair) uploaded by the import-intake service before
 * enqueuing. The worker downloads and processes the pairs from the object
 * store, keeping cleartext out of Redis at all times.
 */
export interface HashImportPropagationJob {
  /** S3 key of the staged ParsedImportPair[] JSON — no cleartext in payload (KTD3). */
  stagingKey: string
  /** Target hash list to upsert. */
  hashListId: number
  /** Project the hash list belongs to — used for audit scope. */
  projectId: number
  /** Actor resolved from auth context at route time, serialized for the worker. */
  actor: AuditActor
  /** Parse-time skip count from U6 — passed through for the final summary. */
  skippedFromParse: number
}

// ─── Job Data Discriminated Union ────────────────────────────────────

export type QueueJobMap = {
  // Priority task queues (all accept TaskGenerationJob)
  [QUEUE_NAMES.TASKS_HIGH]: TaskGenerationJob
  [QUEUE_NAMES.TASKS_NORMAL]: TaskGenerationJob
  [QUEUE_NAMES.TASKS_LOW]: TaskGenerationJob

  // Job queues
  [QUEUE_NAMES.HASH_LIST_PARSING]: HashListParseJob
  [QUEUE_NAMES.TASK_GENERATION]: TaskGenerationJob
  [QUEUE_NAMES.HEARTBEAT_MONITOR]: HeartbeatMonitorJob
  [QUEUE_NAMES.HEALTH_MONITOR]: HealthMonitorJob
  [QUEUE_NAMES.PREEMPTION]: PreemptionJob
  [QUEUE_NAMES.LINE_COUNT]: LineCountJob
  [QUEUE_NAMES.AUDIT_RETENTION]: AuditRetentionJob
  [QUEUE_NAMES.HASH_IMPORT_PROPAGATION]: HashImportPropagationJob
  [QUEUE_NAMES.BLOB_RECLAMATION]: BlobReclamationJob
  [QUEUE_NAMES.RESOURCE_COMPRESSION]: ResourceCompressionJob
  [QUEUE_NAMES.HASH_LIST_SPLIT]: HashListSplitJob
}
