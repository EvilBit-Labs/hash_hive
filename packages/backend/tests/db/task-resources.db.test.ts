/**
 * Real-DB tests for issue #108 U6: `GET /tasks/{taskId}/resources`
 * resolution service (`getResourcesForTask`).
 *
 * Proves what only a live join can prove: the task -> attack ->
 * wordlist/rulelist/masklist resolution actually returns the right
 * rows with real integrity metadata, a resource slot the attack
 * doesn't use is cleanly omitted (not surfaced as null), and the
 * authz join scopes strictly to the requesting agent's own task and
 * project — a task belonging to another agent/project resolves to
 * the typed `{ error }` outcome (404 at the route layer), never a
 * cross-project read or an unhandled throw.
 *
 * Runs under `just test-db`. Do NOT call client.end() — harness.test.ts
 * owns the shared client.
 */

import {
  agents,
  attacks,
  campaigns,
  hashItems,
  hashLists,
  hashTypes,
  maskLists,
  projects,
  tasks,
  wordLists,
} from '@hashhive/shared'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { env } from '../../src/config/env.js'
import { db } from '../../src/db/index.js'
import { computeHashListEtag, getAgentDownloadUrl } from '../../src/services/resources.js'
import { _resourceCompressionDeps } from '../../src/services/resources/resource-compression-trigger.js'
import { getResourcesForTask } from '../../src/services/tasks/task-resources.js'

// Stub the resource-compression enqueue seam so the not-ready self-heal
// (task-resources integrity gate-hole fix, #108) can be asserted without a
// live Redis/QueueManager. This mutates a module-level singleton -- module
// mocks/seam mutations leak process-wide across bun:test files in the same
// invocation (see GOTCHAS.md) -- so the originals are captured up front and
// restored in `afterAll` to guarantee this file cannot affect any other
// `*.db.test.ts` file sharing the `bun test tests/db` process, regardless of
// bun's (unordered) cross-file load sequencing.
const originalGetQueueContext = _resourceCompressionDeps.getQueueContext
const originalGetQueueConfig = _resourceCompressionDeps.getQueueConfig
let compressionEnqueueCalls: unknown[][] = []
_resourceCompressionDeps.getQueueContext = () =>
  Promise.resolve({
    getQueueManager: () => ({
      enqueue: (...args: unknown[]) => {
        compressionEnqueueCalls.push(args)
        return Promise.resolve(true)
      },
    }),
    // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  } as any)
_resourceCompressionDeps.getQueueConfig = () =>
  Promise.resolve({
    QUEUE_NAMES: { RESOURCE_COMPRESSION: 'jobs-resource-compression' },
    // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  } as any)

const SLUG = 'task-resources-test-proj'
const OTHER_SLUG = 'task-resources-other-proj'
// `hash_types.hashcat_mode` is a globally unique column (not project-scoped),
// and the "cross-project" test seeds two projects in the same test run —
// each needs its own mode value or the second insert violates
// `hash_types_hashcat_mode_unique`.
const MODE_BY_SLUG: Record<string, number> = {
  [SLUG]: 9_999_833,
  [OTHER_SLUG]: 9_999_834,
}

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(projects).where(eq(projects.slug, OTHER_SLUG))
  for (const mode of Object.values(MODE_BY_SLUG)) {
    await db.delete(hashTypes).where(eq(hashTypes.hashcatMode, mode))
  }
}

beforeEach(cleanup)
beforeEach(() => {
  compressionEnqueueCalls = []
})
afterAll(cleanup)
afterAll(() => {
  _resourceCompressionDeps.getQueueContext = originalGetQueueContext
  _resourceCompressionDeps.getQueueConfig = originalGetQueueConfig
})

/** Seeds one project with a hash type/list, a mode-`MODE` campaign, an
 * agent, and a `mode: 6` masklist-only attack (no rulelist), then a
 * wordlist + masklist resource with real checksum/size/encoding, then
 * a task assigned to the seeded agent. Returns every id the tests need. */
async function seedProjectWithTask(slug: string): Promise<{
  projectId: number
  agentId: number
  taskId: number
  wordlistId: number
  masklistId: number
}> {
  const [project] = await db.insert(projects).values({ name: slug, slug }).returning()
  const projectId = project!.id

  const [hashType] = await db
    .insert(hashTypes)
    .values({ name: `${slug}-hashtype`, hashcatMode: MODE_BY_SLUG[slug] })
    .returning()
  const [hashList] = await db
    .insert(hashLists)
    .values({ projectId, name: `${slug}-hashlist`, hashTypeId: hashType!.id, status: 'ready' })
    .returning()
  const [campaign] = await db
    .insert(campaigns)
    .values({
      name: `${slug}-camp`,
      projectId,
      hashListId: hashList!.id,
      priority: 1,
      status: 'running',
      hashcatMode: 0,
    })
    .returning()

  const [wordlist] = await db
    .insert(wordLists)
    .values({
      projectId,
      name: `${slug}-wordlist`,
      status: 'ready',
      fileRef: { bucket: env.S3_BUCKET, key: `${slug}/wordlist.txt`, name: 'wordlist.txt' },
      fileChecksum: 'wordlist-checksum-abc123',
      fileSize: 4096,
      compressionEncoding: 'gzip',
    })
    .returning()
  // Fully checksummed by default (real checksum/size/encoding) so the
  // baseline "happy path" tests below prove the normal 200 case. The
  // landed-but-not-yet-checksummed (409) case is exercised by a dedicated
  // test that flips `fileChecksum` back to null on this same row.
  const [masklist] = await db
    .insert(maskLists)
    .values({
      projectId,
      name: `${slug}-masklist`,
      status: 'ready',
      fileRef: { bucket: env.S3_BUCKET, key: `${slug}/masklist.txt`, name: 'masklist.txt' },
      fileChecksum: 'masklist-checksum-def456',
      fileSize: 2048,
      compressionEncoding: 'none',
    })
    .returning()

  // Attack mode 0 references the wordlist + masklist but no rulelist —
  // proves the omit-unused-slot behavior.
  const [attack] = await db
    .insert(attacks)
    .values({
      campaignId: campaign!.id,
      projectId,
      mode: 0,
      wordlistId: wordlist!.id,
      masklistId: masklist!.id,
    })
    .returning()

  const [agent] = await db
    .insert(agents)
    .values({ name: `${slug}-agent`, projectId, capabilities: { gpu: false }, status: 'online' })
    .returning()

  const [task] = await db
    .insert(tasks)
    .values({
      attackId: attack!.id,
      campaignId: campaign!.id,
      agentId: agent!.id,
      status: 'assigned',
      workRange: { start: 0, end: 1000, total: 1000 },
    })
    .returning({ id: tasks.id })

  return {
    projectId,
    agentId: agent!.id,
    taskId: task!.id,
    wordlistId: wordlist!.id,
    masklistId: masklist!.id,
  }
}

describe('getResourcesForTask (#108 U6)', () => {
  it('returns the wordlist + masklist with integrity metadata and omits the unreferenced rulelist', async () => {
    const { projectId, agentId, taskId, wordlistId, masklistId } = await seedProjectWithTask(SLUG)

    const result = await getResourcesForTask(taskId, agentId, projectId)

    if ('error' in result) {
      throw new Error(`expected resources, got error: ${result.error}`)
    }
    expect(result.resources).toHaveLength(2)

    const wordlistEntry = result.resources.find((r) => r.type === 'wordlist')
    expect(wordlistEntry).toMatchObject({
      type: 'wordlist',
      id: wordlistId,
      checksum: 'wordlist-checksum-abc123',
      size: 4096,
      encoding: 'gzip',
    })
    expect(wordlistEntry?.downloadUrl).toMatch(/^https?:\/\//)

    const masklistEntry = result.resources.find((r) => r.type === 'masklist')
    expect(masklistEntry).toMatchObject({
      type: 'masklist',
      id: masklistId,
      checksum: 'masklist-checksum-def456',
      size: 2048,
      encoding: 'none',
    })
    expect(masklistEntry?.downloadUrl).toMatch(/^https?:\/\//)

    // The attack never set rulelistId — no rulelist entry should appear.
    expect(result.resources.some((r) => r.type === 'rulelist')).toBe(false)
  })

  it('reports not-ready and self-heals by re-enqueuing compression for a resource that has landed but has no checksum yet (gate-hole fix)', async () => {
    const { projectId, agentId, taskId, masklistId } = await seedProjectWithTask(SLUG)

    // Simulate the real chunked-upload gap this fix closes: the file has
    // landed (fileRef stays populated, status stays 'ready') but the
    // background checksum/compression worker hasn't produced a checksum
    // yet. Before the fix, getResourcesForTask handed this back as a 200
    // with `checksum: null` -- an agent would crack against, and cache,
    // content it could never verify. It must now be gated exactly like the
    // no-upload-at-all case.
    await db.update(maskLists).set({ fileChecksum: null }).where(eq(maskLists.id, masklistId))

    const result = await getResourcesForTask(taskId, agentId, projectId)

    expect('notReady' in result).toBe(true)
    expect('resources' in result).toBe(false)

    // Self-heal: the lazy re-enqueue must have fired for the masklist so a
    // lost/failed original enqueue (or a crashed worker) recovers on the
    // next agent poll instead of wedging this task behind a permanent 409.
    expect(compressionEnqueueCalls).toHaveLength(1)
    expect(compressionEnqueueCalls[0]?.[0]).toBe('jobs-resource-compression')
    expect(compressionEnqueueCalls[0]?.[1]).toEqual({
      resourceType: 'masklist',
      resourceId: masklistId,
      projectId,
    })
    expect(compressionEnqueueCalls[0]?.[2]).toEqual({ jobId: `compress:masklist:${masklistId}` })
  })

  it('returns a typed error for a task assigned to a different agent (not a throw)', async () => {
    const { projectId, taskId } = await seedProjectWithTask(SLUG)
    const [otherAgent] = await db
      .insert(agents)
      .values({ name: 'other-agent', projectId, capabilities: {}, status: 'online' })
      .returning()

    const result = await getResourcesForTask(taskId, otherAgent!.id, projectId)

    expect('error' in result).toBe(true)
  })

  it('returns a typed error for a task in another project (cross-project read is not possible)', async () => {
    const { taskId } = await seedProjectWithTask(SLUG)
    const other = await seedProjectWithTask(OTHER_SLUG)

    // otherProject's own agent, requesting the FIRST project's task id.
    const result = await getResourcesForTask(taskId, other.agentId, other.projectId)

    expect('error' in result).toBe(true)
  })

  it('returns a typed error for a nonexistent task id', async () => {
    const { projectId, agentId } = await seedProjectWithTask(SLUG)

    const result = await getResourcesForTask(999_999_999, agentId, projectId)

    expect('error' in result).toBe(true)
  })

  it('reports not-ready (never a silent partial list) for a resource that is referenced but has no uploaded file yet (empty fileRef)', async () => {
    const { projectId, agentId, taskId, wordlistId } = await seedProjectWithTask(SLUG)

    // Simulate an attack referencing a wordlist row that was created but
    // never finished uploading (fileRef still `{}`) — distinct from "the
    // attack has no wordlistId at all", which is the null-ID omit case
    // covered above. getAgentDownloadUrl returns null for this row (no
    // bucket/key). An agent cracking against a resource set missing this
    // wordlist would be handed incomplete work, so getResourcesForTask
    // must NOT silently omit it (nor return the masklist alone) -- the
    // whole response is flagged not-ready instead (review fix for #108).
    await db.update(wordLists).set({ fileRef: {} }).where(eq(wordLists.id, wordlistId))

    const result = await getResourcesForTask(taskId, agentId, projectId)

    expect('notReady' in result).toBe(true)
    // The not-ready outcome never leaks a partial resources array (e.g.
    // the still-resolvable masklist) alongside it.
    expect('resources' in result).toBe(false)
  })
})

// ─── getAgentDownloadUrl — hash-list branch (#108 U5) ───────────────
//
// The U5 contract tests in agent-api-contract.test.ts mock
// getAgentDownloadUrl's return value directly, so they prove the ROUTE
// forwards nulls correctly but never exercise the SERVICE's
// `isHashList ? null : ...` branch against a real row. This test seeds
// a hash list WITH a fileRef (so the function gets past the
// no-file-uploaded guard) and proves the service itself reports
// checksum/size/encoding as null for a resource type with no such
// columns, alongside a real, non-null presigned URL.

describe('getAgentDownloadUrl — hash-list integrity metadata (#108 U5)', () => {
  it('returns null checksum/size/encoding for a hash list, with a real download URL', async () => {
    const { projectId } = await seedProjectWithTask(SLUG)
    const [hashList] = await db
      .insert(hashLists)
      .values({
        projectId,
        name: 'hash-list-with-file',
        status: 'ready',
        fileRef: { bucket: env.S3_BUCKET, key: `${SLUG}/hashlist.txt`, name: 'hashlist.txt' },
      })
      .returning()

    const result = await getAgentDownloadUrl('hash-lists', hashList!.id, projectId)

    expect(result).not.toBeNull()
    expect(result?.checksum).toBeNull()
    expect(result?.size).toBeNull()
    expect(result?.encoding).toBeNull()
    expect(result?.url).toMatch(/^https?:\/\//)
  })
})

// ─── computeHashListEtag / getAgentDownloadUrl etag (#108 follow-up) ──
//
// Only a live query against `hash_items.cracked_at` can prove the etag
// actually reflects the current crack state — the contract tests for the
// route pin only the wire shape via a mocked `getAgentDownloadUrl`. These
// tests seed real hash items, crack one, and prove `computeHashListEtag`
// (and the `etag` field `getAgentDownloadUrl` surfaces from it) changes
// only when the last-crack time actually changes.

describe('computeHashListEtag (#108 follow-up: hash-list freshness ETag)', () => {
  it('reports a stable etag for a hash list with no cracked items', async () => {
    const { projectId } = await seedProjectWithTask(SLUG)
    const [hashList] = await db
      .insert(hashLists)
      .values({ projectId, name: 'etag-no-cracks', status: 'ready' })
      .returning()

    await db.insert(hashItems).values([
      { hashListId: hashList!.id, hashValue: 'aaaa' },
      { hashListId: hashList!.id, hashValue: 'bbbb' },
    ])

    const first = await computeHashListEtag(hashList!.id)
    const second = await computeHashListEtag(hashList!.id)

    expect(first).toBe(second)
    expect(first).toBe(`W/"hl-${hashList!.id}-0"`)
  })

  it('changes the etag once a hash item is cracked', async () => {
    const { projectId } = await seedProjectWithTask(SLUG)
    const [hashList] = await db
      .insert(hashLists)
      .values({ projectId, name: 'etag-after-crack', status: 'ready' })
      .returning()

    const [item] = await db
      .insert(hashItems)
      .values({ hashListId: hashList!.id, hashValue: 'cccc' })
      .returning()

    const beforeCrack = await computeHashListEtag(hashList!.id)
    expect(beforeCrack).toBe(`W/"hl-${hashList!.id}-0"`)

    const crackedAt = new Date('2026-01-01T00:00:00.000Z')
    await db.update(hashItems).set({ crackedAt }).where(eq(hashItems.id, item!.id))

    const afterCrack = await computeHashListEtag(hashList!.id)

    expect(afterCrack).not.toBe(beforeCrack)
    expect(afterCrack).toBe(`W/"hl-${hashList!.id}-${crackedAt.getTime()}"`)
  })

  it('surfaces the same value on the etag field getAgentDownloadUrl returns for a hash list', async () => {
    const { projectId } = await seedProjectWithTask(SLUG)
    const [hashList] = await db
      .insert(hashLists)
      .values({
        projectId,
        name: 'etag-download-url',
        status: 'ready',
        fileRef: { bucket: env.S3_BUCKET, key: `${SLUG}/etag-hashlist.txt`, name: 'hl.txt' },
      })
      .returning()

    const expected = await computeHashListEtag(hashList!.id)
    const result = await getAgentDownloadUrl('hash-lists', hashList!.id, projectId)

    expect(result?.etag).toBe(expected)
  })

  it('returns null etag for a non-hash-list resource', async () => {
    const { projectId, wordlistId } = await seedProjectWithTask(SLUG)

    const result = await getAgentDownloadUrl('wordlists', wordlistId, projectId)

    expect(result?.etag).toBeNull()
  })
})
