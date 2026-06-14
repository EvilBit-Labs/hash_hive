/**
 * Durable preemption audit writer (issue #97 U2).
 *
 * Appends one `task_events` row per pause/resume transition. Append-only:
 * there is no update or delete path. Callers (the preemption pause/resume
 * passes in `tasks/preemption.ts`) invoke `recordTaskEvent` inside the same
 * logical transition so an event is never written for a transition that did
 * not commit. Errors propagate — a failed audit write is a real failure, not
 * something to swallow.
 *
 * Lives in the `tasks/` subdir per the barrel-plus-subdir convention so the
 * parent `services/tasks.ts` stays under the per-file budget and
 * `mock.module('.../tasks.js')` registrations keep working.
 */
import {
  type PausedReason,
  type TaskDbStatus,
  type TaskEventType,
  taskEvents,
} from '@hashhive/shared'

import { db } from '../../db/index.js'

/**
 * Input for a single audit row. `reason` is the `pausedReason` on a
 * `preempted` event and null on `resumed`; `byCampaignId` is the
 * higher-priority campaign that triggered a pause (null on resume).
 */
export interface RecordTaskEventInput {
  taskId: number
  eventType: TaskEventType
  fromStatus: TaskDbStatus
  toStatus: TaskDbStatus
  reason?: PausedReason | null
  byCampaignId?: number | null
}

/**
 * Persist one preemption audit row. Returns the inserted row.
 */
export async function recordTaskEvent(input: RecordTaskEventInput) {
  const [row] = await db
    .insert(taskEvents)
    .values({
      taskId: input.taskId,
      eventType: input.eventType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
      byCampaignId: input.byCampaignId ?? null,
    })
    .returning()
  return row
}
