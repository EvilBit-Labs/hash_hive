/**
 * Data migration script: CipherSwarm (Rails/MongoDB) → HashHive (PostgreSQL)
 *
 * Reads NDJSON export files and imports them into the HashHive PostgreSQL database.
 * Each line in the NDJSON file is a JSON object representing one record.
 *
 * Usage:
 *   bun run src/scripts/migrate-data.ts --dir ./exports [--dry-run] [--validate-only]
 *
 * Expected files in --dir:
 *   users.ndjson, projects.ndjson, project_users.ndjson,
 *   agents.ndjson, hash_types.ndjson, hash_lists.ndjson,
 *   hash_items.ndjson, word_lists.ndjson, rule_lists.ndjson,
 *   mask_lists.ndjson, campaigns.ndjson, attacks.ndjson, tasks.ndjson
 */

import * as schema from '@hashhive/shared'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { db } from '../db/index.js'

// ─── CLI Arguments ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const dirIndex = args.indexOf('--dir')
const dirArg = dirIndex >= 0 ? args[dirIndex + 1] : undefined
const dryRun = args.includes('--dry-run')
const validateOnly = args.includes('--validate-only')

if (!dirArg) {
  console.error(
    'Usage: bun run src/scripts/migrate-data.ts --dir ./exports [--dry-run] [--validate-only]'
  )
  process.exit(1)
}

const exportDir = resolve(dirArg)

// ─── Helpers ────────────────────────────────────────────────────────

function readNdjson<T>(filename: string): T[] {
  const filepath = resolve(exportDir, filename)
  if (!existsSync(filepath)) {
    console.log(`  Skipping ${filename} (not found)`)
    return []
  }

  const content = readFileSync(filepath, 'utf-8')
  const lines = content.split('\n').filter((line) => line.trim())
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as T
    } catch {
      throw new Error(`Invalid JSON at ${filename}:${i + 1}`)
    }
  })
}

// Coerce JSON primitive values (string/number/boolean) to a string safely.
// Used in place of `String(unknown)` to satisfy no-base-to-string while
// keeping the script tolerant of mixed primitive types in the export.
function toStr(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

// Rails IDs (string _id or numeric id) → PostgreSQL serial IDs
type IdMap = Map<string, number>

function buildIdMap(records: Array<{ _id?: string; id?: number }>, newIds: number[]): IdMap {
  const map = new Map<string, number>()
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const newId = newIds[i]
    if (!record || newId == null) continue
    const oldId = String(record._id ?? record.id)
    map.set(oldId, newId)
  }
  return map
}

function mapId(idMap: IdMap, oldId: string | number | null | undefined): number | null {
  if (oldId == null) return null
  const mapped = idMap.get(String(oldId))
  if (mapped == null) {
    console.warn(`  Warning: unmapped ID ${oldId}`)
    return null
  }
  return mapped
}

// ─── Import Functions ───────────────────────────────────────────────

const BATCH_SIZE = 500

async function importInBatches<T extends Record<string, unknown>>(
  table: any,
  records: T[],
  label: string
): Promise<number[]> {
  const ids: number[] = []

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const results = await db.insert(table).values(batch).returning({ id: table.id })
    for (const r of results) {
      ids.push(r.id)
    }
  }

  console.log(`  Imported ${ids.length} ${label}`)
  return ids
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`Migration: ${exportDir}`)
  console.log(`Mode: ${dryRun ? 'DRY RUN' : validateOnly ? 'VALIDATE ONLY' : 'IMPORT'}`)
  console.log('')

  // 1. Read all export files
  console.log('Reading export files...')
  const rawUsers = readNdjson<Record<string, unknown>>('users.ndjson')
  const rawProjects = readNdjson<Record<string, unknown>>('projects.ndjson')
  const rawProjectUsers = readNdjson<Record<string, unknown>>('project_users.ndjson')
  const rawAgents = readNdjson<Record<string, unknown>>('agents.ndjson')
  const rawHashTypes = readNdjson<Record<string, unknown>>('hash_types.ndjson')
  const rawHashLists = readNdjson<Record<string, unknown>>('hash_lists.ndjson')
  const rawHashItems = readNdjson<Record<string, unknown>>('hash_items.ndjson')
  const rawWordLists = readNdjson<Record<string, unknown>>('word_lists.ndjson')
  const rawRuleLists = readNdjson<Record<string, unknown>>('rule_lists.ndjson')
  const rawMaskLists = readNdjson<Record<string, unknown>>('mask_lists.ndjson')
  const rawCampaigns = readNdjson<Record<string, unknown>>('campaigns.ndjson')
  const rawAttacks = readNdjson<Record<string, unknown>>('attacks.ndjson')
  const rawTasks = readNdjson<Record<string, unknown>>('tasks.ndjson')

  console.log('')
  console.log('Record counts:')
  const counts = {
    users: rawUsers.length,
    projects: rawProjects.length,
    projectUsers: rawProjectUsers.length,
    agents: rawAgents.length,
    hashTypes: rawHashTypes.length,
    hashLists: rawHashLists.length,
    hashItems: rawHashItems.length,
    wordLists: rawWordLists.length,
    ruleLists: rawRuleLists.length,
    maskLists: rawMaskLists.length,
    campaigns: rawCampaigns.length,
    attacks: rawAttacks.length,
    tasks: rawTasks.length,
  }

  for (const [name, count] of Object.entries(counts)) {
    console.log(`  ${name}: ${count}`)
  }

  if (validateOnly || dryRun) {
    console.log('')
    console.log(dryRun ? 'Dry run complete — no data written.' : 'Validation complete.')
    return
  }

  // 2. Import in dependency order
  console.log('')
  console.log('Importing data...')

  // Users
  const userRecords = rawUsers.map((u) => ({
    email: toStr(u['email']),
    passwordHash: toStr(u['password_hash'] ?? u['encrypted_password'] ?? ''),
    name: toStr(u['name'] ?? u['email']),
    status: 'active',
  }))
  const userIds = await importInBatches(schema.users, userRecords, 'users')
  const userIdMap = buildIdMap(rawUsers, userIds)

  // Projects
  const projectRecords = rawProjects.map((p) => ({
    name: toStr(p['name']),
    description: p['description'] ? toStr(p['description']) : null,
    slug: toStr(p['slug'] ?? toStr(p['name']).toLowerCase().replace(/\s+/g, '-')),
    createdBy: mapId(userIdMap, p['created_by'] as string),
  }))
  const projectIds = await importInBatches(schema.projects, projectRecords, 'projects')
  const projectIdMap = buildIdMap(rawProjects, projectIds)

  // Project Users
  const puRecords = rawProjectUsers.map((pu) => ({
    userId: mapId(userIdMap, pu['user_id'] as string) ?? 0,
    projectId: mapId(projectIdMap, pu['project_id'] as string) ?? 0,
    roles: (pu['roles'] as string[]) ?? ['member'],
  }))
  await importInBatches(schema.projectUsers, puRecords, 'project users')

  // Agents
  const agentRecords = rawAgents.map((a) => ({
    name: toStr(a['name']),
    projectId: mapId(projectIdMap, a['project_id'] as string) ?? 0,
    authToken: toStr(a['auth_token'] ?? crypto.randomUUID()),
    status: toStr(a['status'] ?? 'offline'),
    capabilities: (a['capabilities'] as Record<string, unknown>) ?? {},
    hardwareProfile: (a['hardware_profile'] as Record<string, unknown>) ?? {},
  }))
  const agentIds = await importInBatches(schema.agents, agentRecords, 'agents')
  const agentIdMap = buildIdMap(rawAgents, agentIds)

  // Hash Types
  const htRecords = rawHashTypes.map((ht) => ({
    name: toStr(ht['name']),
    hashcatMode: Number(ht['hashcat_mode']),
    category: ht['category'] ? toStr(ht['category']) : null,
    example: ht['example'] ? toStr(ht['example']) : null,
  }))
  const htIds = await importInBatches(schema.hashTypes, htRecords, 'hash types')
  const hashTypeIdMap = buildIdMap(rawHashTypes, htIds)

  // Hash Lists
  const hlRecords = rawHashLists.map((hl) => ({
    projectId: mapId(projectIdMap, hl['project_id'] as string) ?? 0,
    name: toStr(hl['name']),
    hashTypeId: mapId(hashTypeIdMap, hl['hash_type_id'] as string),
    source: toStr(hl['source'] ?? 'upload'),
    status: toStr(hl['status'] ?? 'ready'),
  }))
  const hlIds = await importInBatches(schema.hashLists, hlRecords, 'hash lists')
  const hashListIdMap = buildIdMap(rawHashLists, hlIds)

  // Hash Items (can be large — batched)
  const hiRecords = rawHashItems.map((hi) => ({
    hashListId: mapId(hashListIdMap, hi['hash_list_id'] as string) ?? 0,
    hashValue: toStr(hi['hash_value']),
    plaintext: hi['plaintext'] ? toStr(hi['plaintext']) : null,
    crackedAt: hi['cracked_at'] ? new Date(hi['cracked_at'] as string) : null,
  }))
  await importInBatches(schema.hashItems, hiRecords, 'hash items')

  // Wordlists, Rulelists, Masklists
  const wlRecords = rawWordLists.map((wl) => ({
    projectId: mapId(projectIdMap, wl['project_id'] as string) ?? 0,
    name: String(wl['name']),
    lineCount: wl['line_count'] ? Number(wl['line_count']) : null,
    fileSize: wl['file_size'] ? Number(wl['file_size']) : null,
  }))
  const wlIds = await importInBatches(schema.wordLists, wlRecords, 'word lists')
  const wordListIdMap = buildIdMap(rawWordLists, wlIds)

  const rlRecords = rawRuleLists.map((rl) => ({
    projectId: mapId(projectIdMap, rl['project_id'] as string) ?? 0,
    name: String(rl['name']),
    lineCount: rl['line_count'] ? Number(rl['line_count']) : null,
    fileSize: rl['file_size'] ? Number(rl['file_size']) : null,
  }))
  const rlIds = await importInBatches(schema.ruleLists, rlRecords, 'rule lists')
  const ruleListIdMap = buildIdMap(rawRuleLists, rlIds)

  const mlRecords = rawMaskLists.map((ml) => ({
    projectId: mapId(projectIdMap, ml['project_id'] as string) ?? 0,
    name: String(ml['name']),
    lineCount: ml['line_count'] ? Number(ml['line_count']) : null,
    fileSize: ml['file_size'] ? Number(ml['file_size']) : null,
  }))
  const mlIds = await importInBatches(schema.maskLists, mlRecords, 'mask lists')
  const maskListIdMap = buildIdMap(rawMaskLists, mlIds)

  // Campaigns
  const campaignRecords = rawCampaigns.map((c) => ({
    projectId: mapId(projectIdMap, c['project_id'] as string) ?? 0,
    name: toStr(c['name']),
    description: c['description'] ? toStr(c['description']) : null,
    hashListId: mapId(hashListIdMap, c['hash_list_id'] as string) ?? 0,
    status: toStr(c['status'] ?? 'draft'),
    priority: Number(c['priority'] ?? 5),
    createdBy: mapId(userIdMap, c['created_by'] as string),
    startedAt: c['started_at'] ? new Date(c['started_at'] as string) : null,
    completedAt: c['completed_at'] ? new Date(c['completed_at'] as string) : null,
  }))
  const campaignIds = await importInBatches(schema.campaigns, campaignRecords, 'campaigns')
  const campaignIdMap = buildIdMap(rawCampaigns, campaignIds)

  // Attacks
  const attackRecords = rawAttacks.map((a) => ({
    campaignId: mapId(campaignIdMap, a['campaign_id'] as string) ?? 0,
    projectId: mapId(projectIdMap, a['project_id'] as string) ?? 0,
    mode: Number(a['mode']),
    hashTypeId: mapId(hashTypeIdMap, a['hash_type_id'] as string),
    wordlistId: mapId(wordListIdMap, a['wordlist_id'] as string),
    rulelistId: mapId(ruleListIdMap, a['rulelist_id'] as string),
    masklistId: mapId(maskListIdMap, a['masklist_id'] as string),
    advancedConfiguration: (a['advanced_configuration'] as Record<string, unknown>) ?? {},
    keyspace: a['keyspace'] ? toStr(a['keyspace']) : null,
    status: toStr(a['status'] ?? 'pending'),
    dependencies: (a['dependencies'] as number[]) ?? null,
  }))
  const attackIds = await importInBatches(schema.attacks, attackRecords, 'attacks')
  const attackIdMap = buildIdMap(rawAttacks, attackIds)

  // Tasks
  const taskRecords = rawTasks.map((t) => ({
    attackId: mapId(attackIdMap, t['attack_id'] as string) ?? 0,
    campaignId: mapId(campaignIdMap, t['campaign_id'] as string) ?? 0,
    agentId: mapId(agentIdMap, t['agent_id'] as string),
    status: toStr(t['status'] ?? 'pending'),
    workRange: (t['work_range'] as Record<string, unknown>) ?? {},
    progress: (t['progress'] as Record<string, unknown>) ?? {},
    resultStats: (t['result_stats'] as Record<string, unknown>) ?? {},
    failureReason: t['failure_reason'] ? toStr(t['failure_reason']) : null,
    assignedAt: t['assigned_at'] ? new Date(t['assigned_at'] as string) : null,
    startedAt: t['started_at'] ? new Date(t['started_at'] as string) : null,
    completedAt: t['completed_at'] ? new Date(t['completed_at'] as string) : null,
  }))
  await importInBatches(schema.tasks, taskRecords, 'tasks')

  // 3. Validation
  console.log('')
  console.log('Validating import...')
  const validateTable = async (table: any, label: string, expected: number) => {
    const result = await db.select({ id: table.id }).from(table)
    const actual = result.length
    const status = actual >= expected ? 'OK' : 'MISMATCH'
    console.log(`  ${label}: ${actual} (expected ${expected}) [${status}]`)
  }

  await validateTable(schema.users, 'users', counts.users)
  await validateTable(schema.projects, 'projects', counts.projects)
  await validateTable(schema.agents, 'agents', counts.agents)
  await validateTable(schema.hashLists, 'hash_lists', counts.hashLists)
  await validateTable(schema.campaigns, 'campaigns', counts.campaigns)
  await validateTable(schema.attacks, 'attacks', counts.attacks)
  await validateTable(schema.tasks, 'tasks', counts.tasks)

  console.log('')
  console.log('Migration complete.')
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
