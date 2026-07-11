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
 *
 * A slot the attack simply doesn't use (its FK column is NULL) is
 * cleanly omitted — that's normal. A slot whose FK IS set but fails to
 * resolve to a *complete* download (no download at all, OR a download
 * with a null `checksum`, OR a download with a null `size`) is a
 * different, non-silent case: an agent cracking against an incomplete
 * or unverified resource set is a correctness bug. `getResourcesForTask`
 * never hands back a partial or unverified resource list for these —
 * but it does distinguish (PR #282 review) WHY the slot failed to
 * resolve, because the two causes need different caller behavior:
 *
 *   - **Transient (retriable).** The resource row still exists in the
 *     task's project — the upload hasn't finished, or it's landed but
 *     the background checksum/compression worker hasn't run yet. This
 *     is a typed `{ notReady: true }` outcome (409 at the route layer)
 *     and also re-enqueues the compression worker (best-effort,
 *     idempotent) so a lost or failed original enqueue self-heals on
 *     the next agent poll instead of wedging the task behind a 409
 *     forever.
 *   - **Permanent (not retriable).** The resource row does NOT exist in
 *     the task's project at all — hard-deleted, pointed at a different
 *     project, or otherwise misconfigured. Looping an agent through 409
 *     forever here would never resolve, so this instead returns the
 *     generic `{ error: string }` outcome (a typed 4xx at the route
 *     layer, never a 409) and logs at `warn` — a task referencing a
 *     resource that doesn't exist in its own project is a real
 *     configuration problem worth surfacing loudly.
 */
import {
  attacks,
  campaigns,
  maskLists,
  ruleLists,
  tasks,
  type TaskResourceEntry,
  type TaskResourceType,
  wordLists,
} from '@hashhive/shared'
import { and, eq } from 'drizzle-orm'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { getAgentDownloadUrl, type ResourceTable } from '../resources.js'
import { enqueueResourceCompression } from '../resources/resource-compression-trigger.js'

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

/** `downloadType` -> the underlying resource table, used only for the
 * project-scoped existence probe (`resourceRowExistsInProject` below) that
 * distinguishes a transient not-ready state from a permanent missing-row
 * state. */
const RESOURCE_TABLE_BY_DOWNLOAD_TYPE: Record<
  (typeof RESOURCE_SLOTS)[number]['downloadType'],
  ResourceTable
> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
}

/**
 * Lightweight existence probe (`SELECT 1 ... LIMIT 1`) used only after
 * `getAgentDownloadUrl` has already failed to produce a complete download
 * for a referenced slot — distinguishes "the row exists in this project but
 * isn't finished processing yet" (transient, retry) from "the row does not
 * exist in this project at all" (permanent, deleted/cross-project/
 * misconfigured — retrying can never fix this).
 */
async function resourceRowExistsInProject(
  downloadType: (typeof RESOURCE_SLOTS)[number]['downloadType'],
  resourceId: number,
  projectId: number
): Promise<boolean> {
  const table = RESOURCE_TABLE_BY_DOWNLOAD_TYPE[downloadType]
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1)
  return row !== undefined
}

export type GetResourcesForTaskResult =
  | { resources: TaskResourceEntry[] }
  // Also doubles (PR #282 review) as the permanent outcome for a
  // referenced resource slot that does not exist in the task's project at
  // all (deleted / cross-project / misconfigured reference) — see the
  // module doc comment above. Never a 409; the route maps this to a
  // typed 4xx exactly like the "task not found" case already handled here.
  | { error: string }
  // A referenced (non-null FK) resource slot resolved to an incomplete
  // download (missing entirely, or missing checksum/size) AND the
  // underlying row still exists in this project — the task's resource set
  // is incomplete or unverified right now, but retrying may resolve it.
  // Distinct from a slot the attack simply doesn't use, which is never
  // surfaced at all, and distinct from the permanent `{ error }` case
  // above. Retriable: the caller (agent) should back off and re-poll
  // rather than cracking against a partial or unverified set.
  | { notReady: true }

export async function getResourcesForTask(
  taskId: number,
  agentId: number,
  projectId: number
): Promise<GetResourcesForTaskResult> {
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
      download: await getAgentDownloadUrl(slot.downloadType, resourceId, projectId),
    }))
  )

  const resources: TaskResourceEntry[] = []
  let hasUnresolvedReference = false
  for (const { slot, resourceId, download } of resolved) {
    // A "200 entry always carries complete integrity metadata" contract
    // (PR #282 review) — gate on ALL THREE of no-download / null checksum /
    // null size, not just checksum, so a resource missing only its size
    // (which the schema now also requires non-null) is caught here too.
    // Written as direct non-null checks (rather than a derived boolean) so
    // TypeScript narrows `download.checksum`/`download.size` to non-null
    // inside this branch, matching the now-non-nullable `TaskResourceEntry`.
    if (download && download.checksum !== null && download.size !== null) {
      resources.push({
        type: slot.outputType,
        id: resourceId,
        checksum: download.checksum,
        size: download.size,
        // `encoding` is typed nullable on `AgentDownloadUrlResult` because
        // it's `null` for hash lists (out of scope here — this loop only
        // ever calls `getAgentDownloadUrl` with wordlists/rulelists/
        // masklists), where the column defaults to `'none'` and is never
        // actually null. The `?? 'none'` fallback matches that same default
        // and is defensive only, not a real runtime path.
        encoding: download.encoding ?? 'none',
        downloadUrl: download.url,
      })
      continue
    }

    // The slot failed to resolve to a complete download. Distinguish WHY
    // (PR #282 review) before deciding how to respond: a resource row that
    // still exists in this project just hasn't finished uploading or being
    // checksum/compression-processed yet (transient, retriable); a resource
    // row that does not exist in this project at all is permanently
    // unresolvable (deleted, cross-project, or a bad reference) and must
    // never loop the caller through 409 forever.
    const existsInProject = await resourceRowExistsInProject(
      slot.downloadType,
      resourceId,
      projectId
    )

    if (!existsInProject) {
      logger.warn(
        { taskId, agentId, projectId, resourceType: slot.outputType, resourceId },
        "getResourcesForTask: referenced resource does not exist in this task's project (deleted, cross-project, or misconfigured reference); returning a permanent error"
      )
      return {
        error: `Referenced ${slot.outputType} resource ${resourceId} does not exist in this task's project`,
      }
    }

    // Transient: the row exists, it just isn't finished processing yet.
    // This is an EXPECTED state agents poll through routinely, so it's
    // logged at `debug` (PR #282 review), not `warn` — a per-poll `warn`
    // here would be noise, unlike the permanent-missing case above (which
    // is a real configuration problem worth surfacing loudly) or an
    // enqueue *failure* (still `warn`, see `enqueueResourceCompression`).
    hasUnresolvedReference = true
    logger.debug(
      { taskId, agentId, projectId, resourceType: slot.outputType, resourceId },
      'getResourcesForTask: referenced resource is not fully processed yet (no download, or missing checksum/size); reporting not-ready and re-enqueuing compression'
    )
    // Self-heal (best-effort): re-enqueue the compression/checksum worker
    // so a lost or failed original enqueue -- or a worker that crashed
    // mid-run -- recovers on the next agent poll instead of wedging this
    // task behind a permanent 409. `enqueueResourceCompression` is
    // idempotent (deduped jobId) and the worker itself no-ops once
    // `file_checksum` is set (and gracefully no-ops when `fileRef` isn't
    // set yet either), so this can never race or duplicate a legitimate
    // in-flight compression pass. It also never throws -- failures are
    // logged and swallowed internally -- so it's safe to await unguarded
    // here regardless of which of the three incomplete-download causes
    // triggered this branch.
    await enqueueResourceCompression(slot.outputType, resourceId, projectId)
  }

  if (hasUnresolvedReference) {
    return { notReady: true }
  }

  return { resources }
}
