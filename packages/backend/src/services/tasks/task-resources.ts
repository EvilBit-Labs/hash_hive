/**
 * Task -> static-resource resolution for the agent API (issue #108 U6).
 *
 * Closes a gap in the assigned-task payload: `assignNextTask` / `GET
 * /tasks/next` return a task's `attackId` but never the wordlist/
 * rulelist/masklist ids that attack references, so an agent has no way
 * to discover which resource ids to ask `GET
 * /resources/{type}/{id}/download-url` about. `getResourcesForTask`
 * resolves task -> attack -> resource ids and returns one entry per
 * resource the attack actually references (omitting slots the attack
 * doesn't use), reusing `getAgentDownloadUrl` (#108 U5) for both the
 * integrity metadata (checksum/size/encoding) and the download URL so
 * this route and `GET /resources/{type}/{id}/download-url` can never
 * disagree about a given resource.
 *
 * Authz mirrors `getZapsForTask` (./zaps.ts) exactly: the task must be
 * assigned to the calling agent AND its campaign must belong to the
 * calling agent's project. A leaked/guessed task id from another
 * project or another agent's task resolves to "task not found" (a
 * typed 404), never a cross-project or cross-agent read, and never an
 * unhandled throw.
 *
 * Hash lists are entirely out of #108 scope (no checksum/size/encoding
 * columns) and are never included in the output — only wordlist/
 * rulelist/masklist, matching the attack schema's three resource slots.
 */
import {
  attacks,
  campaigns,
  tasks,
  type TaskResourceEntry,
  type TaskResourceType,
} from '@hashhive/shared'
import { and, eq } from 'drizzle-orm'

import { db } from '../../db/index.js'
import { getAgentDownloadUrl } from '../resources.js'

/**
 * Maps each of the attack's three resource FK columns to the
 * `getAgentDownloadUrl` resourceType string and the output `type`
 * literal on `TaskResourceEntry`. `as const satisfies` keeps this a
 * plain readonly literal array (for iteration) while still checking
 * its shape against the wire-facing `TaskResourceType` union.
 */
const RESOURCE_SLOTS = [
  { column: 'wordlistId', downloadType: 'wordlists', outputType: 'wordlist' },
  { column: 'rulelistId', downloadType: 'rulelists', outputType: 'rulelist' },
  { column: 'masklistId', downloadType: 'masklists', outputType: 'masklist' },
] as const satisfies ReadonlyArray<{
  column: 'wordlistId' | 'rulelistId' | 'masklistId'
  downloadType: 'wordlists' | 'rulelists' | 'masklists'
  outputType: TaskResourceType
}>

export async function getResourcesForTask(
  taskId: number,
  agentId: number,
  projectId: number
): Promise<{ resources: TaskResourceEntry[] } | { error: string }> {
  // Single join: tasks -> attacks (resource FKs) + tasks -> campaigns
  // (project scope + agent-assignment gate), mirroring getZapsForTask's
  // authz join exactly rather than substituting attacks.projectId —
  // the campaigns join is the established trust boundary for this
  // agent-facing surface even though the two project ids should always
  // agree.
  const [row] = await db
    .select({
      wordlistId: attacks.wordlistId,
      rulelistId: attacks.rulelistId,
      masklistId: attacks.masklistId,
    })
    .from(tasks)
    .innerJoin(attacks, eq(tasks.attackId, attacks.id))
    .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
    .where(
      and(eq(tasks.id, taskId), eq(tasks.agentId, agentId), eq(campaigns.projectId, projectId))
    )
    .limit(1)

  if (!row) {
    return { error: 'Task not found or not assigned to this agent' }
  }

  // Resolve populated slots concurrently -- each is an independent DB
  // round-trip via `getAgentDownloadUrl`, and this endpoint is polled
  // per-task by every agent. `Promise.all` preserves the input array's
  // order regardless of completion order, so `resources` below stays in
  // `RESOURCE_SLOTS` order exactly as the sequential loop produced.
  const populatedSlots = RESOURCE_SLOTS.map((slot) => ({
    slot,
    resourceId: row[slot.column],
  })).filter(
    (entry): entry is { slot: (typeof RESOURCE_SLOTS)[number]; resourceId: number } =>
      entry.resourceId != null
  )

  const resolved = await Promise.all(
    populatedSlots.map(async ({ slot, resourceId }) => ({
      slot,
      resourceId,
      // A resource id set on the attack but with no uploaded file yet
      // (upload started, checksum/compression worker hasn't finished, or
      // the row was deleted out from under the attack) has no meaningful
      // download URL to hand back. Omit it rather than surfacing a
      // null-downloadUrl entry an agent would try to fetch and fail on.
      download: await getAgentDownloadUrl(slot.downloadType, resourceId, projectId),
    }))
  )

  const resources: TaskResourceEntry[] = []
  for (const { slot, resourceId, download } of resolved) {
    if (!download) continue

    resources.push({
      type: slot.outputType,
      id: resourceId,
      checksum: download.checksum,
      size: download.size,
      encoding: download.encoding,
      downloadUrl: download.url,
    })
  }

  return { resources }
}
