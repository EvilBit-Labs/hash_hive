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
import { getAgentDownloadUrl } from '../../src/services/resources.js'
import { getResourcesForTask } from '../../src/services/tasks/task-resources.js'

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
afterAll(cleanup)

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
  const [masklist] = await db
    .insert(maskLists)
    .values({
      projectId,
      name: `${slug}-masklist`,
      status: 'ready',
      fileRef: { bucket: env.S3_BUCKET, key: `${slug}/masklist.txt`, name: 'masklist.txt' },
      fileChecksum: null, // worker hasn't run yet — must surface as null, not a 500.
      fileSize: null,
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

    // Not-yet-checksummed masklist: null checksum/size cleanly, not a 500.
    const masklistEntry = result.resources.find((r) => r.type === 'masklist')
    expect(masklistEntry).toMatchObject({
      type: 'masklist',
      id: masklistId,
      checksum: null,
      size: null,
      encoding: 'none',
    })
    expect(masklistEntry?.downloadUrl).toMatch(/^https?:\/\//)

    // The attack never set rulelistId — no rulelist entry should appear.
    expect(result.resources.some((r) => r.type === 'rulelist')).toBe(false)
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

  it('omits a resource that is referenced but has no uploaded file yet (empty fileRef)', async () => {
    const { projectId, agentId, taskId, wordlistId } = await seedProjectWithTask(SLUG)

    // Simulate an attack referencing a wordlist row that was created but
    // never finished uploading (fileRef still `{}`) — distinct from "the
    // attack has no wordlistId at all", which is the null-ID omit case
    // covered above. getAgentDownloadUrl returns null for this row
    // (no bucket/key), so getResourcesForTask must omit it too, not
    // surface a null-downloadUrl entry.
    await db.update(wordLists).set({ fileRef: {} }).where(eq(wordLists.id, wordlistId))

    const result = await getResourcesForTask(taskId, agentId, projectId)

    if ('error' in result) {
      throw new Error(`expected resources, got error: ${result.error}`)
    }
    expect(result.resources.some((r) => r.type === 'wordlist')).toBe(false)
    // The masklist is unaffected and still comes back.
    expect(result.resources.some((r) => r.type === 'masklist')).toBe(true)
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
