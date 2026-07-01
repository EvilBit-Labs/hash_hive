/**
 * Real-DB tests for the agent advanced-config storage layer (#104, U2 + U3):
 * the `agents.config` jsonb column, the `fleet_agent_config` singleton, and
 * the service functions that read/write/resolve them.
 * A mocked db cannot prove the singleton CHECK constraint, the jsonb
 * round-trip, or the audit-event emission — the DDL and tx behaviour are
 * what is under test.
 */

import { agentErrors, auditLogs, agents, fleetAgentConfig, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, desc, eq, inArray } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  getAgentConfig,
  getFleetDefault,
  resolveEffectiveConfig,
  resolveEffectiveWhitelist,
  updateAgentConfig,
  updateFleetDefault,
} from '../../src/services/agent-config.js'
import { listAgents, logAgentError } from '../../src/services/agents.js'
import { processHeartbeat } from '../../src/services/agents/heartbeat.js'
import {
  REVIEW_RECOMMENDED_THRESHOLD,
  WHITELISTED_SEVERITY,
} from '../../src/services/agents/whitelist.js'

const SLUG = 'agent-config-u2-test'
let projectId = 0
let agentId = 0

async function cleanupAuditRows(): Promise<void> {
  // fleet_config audit rows use projectId=null so project cascade won't touch them.
  // Clean them up explicitly to keep tests isolated across runs.
  await db
    .delete(auditLogs)
    .where(and(eq(auditLogs.entityType, 'fleet_config'), eq(auditLogs.entityId, 1)))
}

async function cleanup(): Promise<void> {
  // Deleting the project cascades to its agents and their audit rows.
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(fleetAgentConfig).where(inArray(fleetAgentConfig.id, [1, 2]))
  await cleanupAuditRows()
}

beforeAll(async () => {
  await cleanup()
  const [project] = await db
    .insert(projects)
    .values({ name: 'Config test', slug: SLUG })
    .returning()
  projectId = project!.id
  const [agent] = await db.insert(agents).values({ name: 'cfg-agent', projectId }).returning()
  agentId = agent!.id
})

afterAll(async () => {
  // Do NOT call client.end() — harness.test.ts owns the shared drizzle pool.
  await cleanup()
})

describe('agents.config column', () => {
  it('round-trips a per-rig config jsonb', async () => {
    const config = {
      tuning: { hashcat: { workloadProfile: 3 } },
      errorWhitelist: ['No hashes loaded'],
    }
    await db.update(agents).set({ config }).where(eq(agents.id, agentId))
    const [row] = await db
      .select({ config: agents.config })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(row!.config).toEqual(config)
  })

  it('defaults to an empty object', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: 'cfg-agent-default', projectId })
      .returning()
    expect(agent!.config).toEqual({})
  })
})

describe('fleet_agent_config singleton', () => {
  it('stores and reads the id=1 row', async () => {
    const config = { tuning: { hashcat: { workloadProfile: 2 } } }
    await db
      .insert(fleetAgentConfig)
      .values({ id: 1, config })
      .onConflictDoUpdate({ target: fleetAgentConfig.id, set: { config } })
    const [row] = await db.select().from(fleetAgentConfig).where(eq(fleetAgentConfig.id, 1))
    expect(row!.config).toEqual(config)
  })

  it('rejects a non-singleton row via the id=1 CHECK', async () => {
    let rejected = false
    try {
      await db.insert(fleetAgentConfig).values({ id: 2, config: {} })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})

// ─── U3: Service-layer tests ──────────────────────────────────────────────────

describe('updateFleetDefault', () => {
  it('writes a fleet_config audit row with entityType fleet_config', async () => {
    await cleanupAuditRows()

    await updateFleetDefault(
      { tuning: { hashcat: { workloadProfile: 3 } } },
      { actorType: 'system', actorId: null }
    )

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'fleet_config'), eq(auditLogs.entityId, 1)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)

    expect(auditRow).toBeDefined()
    expect(auditRow!.entityType).toBe('fleet_config')
    expect(auditRow!.entityId).toBe(1)
    expect(auditRow!.action).toBe('updated')
    expect(auditRow!.projectId).toBeNull()
  })

  it('returns the new merged config', async () => {
    // Seed a known fleet state.
    await updateFleetDefault({ tuning: { hashcat: { workloadProfile: 2 } } })
    const result = await updateFleetDefault({ tuning: { hashcat: { kernelAccel: 16 } } })
    // kernelAccel patch is applied; workloadProfile persists from previous write.
    expect(result.tuning?.hashcat?.kernelAccel).toBe(16)
    expect(result.tuning?.hashcat?.workloadProfile).toBe(2)
  })
})

describe('updateAgentConfig', () => {
  it('persists config and returns merged result', async () => {
    // Reset rig config to a known state.
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))

    const result = await updateAgentConfig(
      agentId,
      { tuning: { hashcat: { workloadProfile: 4 } } },
      { actorType: 'system', actorId: null }
    )

    expect(result.tuning?.hashcat?.workloadProfile).toBe(4)
  })

  it('merges successive patches — existing knobs are not wiped', async () => {
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))

    await updateAgentConfig(agentId, { tuning: { hashcat: { workloadProfile: 3 } } })
    const result = await updateAgentConfig(agentId, { tuning: { hashcat: { kernelLoops: 8 } } })

    expect(result.tuning?.hashcat?.workloadProfile).toBe(3)
    expect(result.tuning?.hashcat?.kernelLoops).toBe(8)
  })

  it('records an audit event with entityType agent', async () => {
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))

    await updateAgentConfig(
      agentId,
      { tuning: { hashcat: { workloadProfile: 2 } } },
      { actorType: 'system', actorId: null }
    )

    const [auditRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent'), eq(auditLogs.entityId, agentId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)

    expect(auditRow).toBeDefined()
    expect(auditRow!.entityType).toBe('agent')
    expect(auditRow!.action).toBe('updated')
    expect(auditRow!.projectId).toBe(projectId)
  })
})

describe('resolveEffectiveConfig', () => {
  it('returns fleet tuning value when rig has no override', async () => {
    // Ensure rig has no tuning.
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))
    // Set fleet default.
    await updateFleetDefault({ tuning: { hashcat: { workloadProfile: 2 } } })

    const effective = await resolveEffectiveConfig(agentId)
    expect(effective.tuning.hashcat?.workloadProfile).toBe(2)
  })

  it('returns per-rig override when rig specifies a tuning knob', async () => {
    await updateFleetDefault({ tuning: { hashcat: { workloadProfile: 2 } } })
    await updateAgentConfig(agentId, { tuning: { hashcat: { workloadProfile: 4 } } })

    const effective = await resolveEffectiveConfig(agentId)
    expect(effective.tuning.hashcat?.workloadProfile).toBe(4)
  })

  it('hardware knob is never inherited from fleet', async () => {
    // Fleet config has no hardware field — verify hardware comes only from rig.
    await db
      .update(agents)
      .set({ config: { hardware: { deviceIds: [1], tempAbort: 85 } } })
      .where(eq(agents.id, agentId))

    const effective = await resolveEffectiveConfig(agentId)
    expect(effective.hardware.deviceIds).toEqual([1])
    expect(effective.hardware.tempAbort).toBe(85)
  })

  it('hardware is empty when rig has none set', async () => {
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))

    const effective = await resolveEffectiveConfig(agentId)
    expect(effective.hardware).toEqual({})
  })

  it('always returns both tuning and hardware keys', async () => {
    const effective = await resolveEffectiveConfig(agentId)
    expect('tuning' in effective).toBe(true)
    expect('hardware' in effective).toBe(true)
  })
})

describe('resolveEffectiveWhitelist', () => {
  it('returns UNION of fleet and rig entries, deduped', async () => {
    await updateFleetDefault({ errorWhitelist: ['fleet-pattern', 'shared'] })
    await updateAgentConfig(agentId, { errorWhitelist: ['rig-pattern', 'shared'] })

    const whitelist = await resolveEffectiveWhitelist(agentId)
    expect(whitelist).toContain('fleet-pattern')
    expect(whitelist).toContain('rig-pattern')
    expect(whitelist.filter((e) => e === 'shared')).toHaveLength(1)
  })

  it('returns only fleet entries when rig has none', async () => {
    await updateFleetDefault({ errorWhitelist: ['fleet-only'] })
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))

    const whitelist = await resolveEffectiveWhitelist(agentId)
    expect(whitelist).toContain('fleet-only')
  })

  it('returns only rig entries when fleet has none', async () => {
    await updateFleetDefault({})
    await updateAgentConfig(agentId, { errorWhitelist: ['rig-only'] })

    const whitelist = await resolveEffectiveWhitelist(agentId)
    expect(whitelist).toContain('rig-only')
  })
})

describe('getAgentConfig', () => {
  it('returns parsed config', async () => {
    const config = { tuning: { hashcat: { workloadProfile: 1 } } }
    await db.update(agents).set({ config }).where(eq(agents.id, agentId))
    const result = await getAgentConfig(agentId)
    expect(result).toEqual(config)
  })

  it('returns {} when config is empty', async () => {
    await db.update(agents).set({ config: {} }).where(eq(agents.id, agentId))
    const result = await getAgentConfig(agentId)
    expect(result).toEqual({})
  })
})

describe('getFleetDefault', () => {
  it('returns parsed fleet config', async () => {
    const config = { tuning: { hashcat: { workloadProfile: 3 } } }
    await db
      .insert(fleetAgentConfig)
      .values({ id: 1, config })
      .onConflictDoUpdate({ target: fleetAgentConfig.id, set: { config } })
    const result = await getFleetDefault()
    expect(result.tuning?.hashcat?.workloadProfile).toBe(3)
  })

  it('returns {} when no fleet row exists', async () => {
    await db.delete(fleetAgentConfig).where(eq(fleetAgentConfig.id, 1))
    const result = await getFleetDefault()
    expect(result).toEqual({})
  })
})

// ─── U4: Whitelist downgrade + reviewRecommended ──────────────────────────────

describe('U4: whitelisted error downgrade (AE2)', () => {
  async function clearErrors(): Promise<void> {
    await db.delete(agentErrors).where(eq(agentErrors.agentId, agentId))
  }

  async function resetAgentStatus(status = 'online'): Promise<void> {
    await db.update(agents).set({ status }).where(eq(agents.id, agentId))
  }

  // ── Heartbeat ingress (primary path) ────────────────────────────────

  it('AE2: whitelisted fatal heartbeat error does NOT flip agent to error status', async () => {
    await clearErrors()
    await resetAgentStatus('online')
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })

    await processHeartbeat(agentId, {
      status: 'online',
      error: { severity: 'fatal', message: 'No hashes loaded' },
    })

    const [row] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(row!.status).toBe('online')
  })

  it('AE2: whitelisted fatal heartbeat error is persisted with info severity and whitelisted marker', async () => {
    await clearErrors()
    await resetAgentStatus('online')
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })

    await processHeartbeat(agentId, {
      status: 'online',
      error: { severity: 'fatal', message: 'No hashes loaded' },
    })

    const [errorRow] = await db
      .select()
      .from(agentErrors)
      .where(eq(agentErrors.agentId, agentId))
      .limit(1)

    expect(errorRow).toBeDefined()
    expect(errorRow!.severity).toBe(WHITELISTED_SEVERITY)
    expect((errorRow!.context as Record<string, unknown>)['whitelisted']).toBe(true)
    expect(errorRow!.message).toBe('No hashes loaded')
  })

  it('AE2: whitelisted heartbeat error does NOT increment errorCount24h badge', async () => {
    await clearErrors()
    await resetAgentStatus('online')
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })

    await processHeartbeat(agentId, {
      status: 'online',
      error: { severity: 'fatal', message: 'No hashes loaded' },
    })

    const result = await listAgents({ projectId })
    const agent = result.agents.find((a) => a.id === agentId)
    expect(agent!.errorCount24h).toBe(0)
    expect(agent!.worstSeverity24h).toBeNull()
  })

  it('contrast: a non-whitelisted fatal heartbeat error flips agent to error status', async () => {
    await clearErrors()
    await resetAgentStatus('online')
    // Clear per-rig whitelist so nothing is whitelisted.
    await updateAgentConfig(agentId, { errorWhitelist: [] })
    await updateFleetDefault({ errorWhitelist: [] })

    await processHeartbeat(agentId, {
      status: 'online',
      error: { severity: 'fatal', message: 'GPU out of memory' },
    })

    const [row] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(row!.status).toBe('error')

    const result = await listAgents({ projectId })
    const agent = result.agents.find((a) => a.id === agentId)
    expect(agent!.errorCount24h).toBe(1)
    expect(agent!.worstSeverity24h).toBe('fatal')
  })

  // ── /errors path (standalone ingress) ───────────────────────────────

  it('/errors path: logAgentError after downgrade persists whitelisted row', async () => {
    await clearErrors()
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })
    await updateFleetDefault({})

    // Simulate the /errors handler calling resolveEffectiveWhitelist + downgradeIfWhitelisted
    // then logAgentError — exactly what the route does.
    const { resolveEffectiveWhitelist: resolveWL } =
      await import('../../src/services/agent-config.js')
    const { downgradeIfWhitelisted } = await import('../../src/services/agents/whitelist.js')

    const whitelist = await resolveWL(agentId)
    const raw = { severity: 'error', message: 'No hashes loaded' }
    const effective = downgradeIfWhitelisted(raw, whitelist)
    await logAgentError({ ...effective, agentId })

    const [errorRow] = await db
      .select()
      .from(agentErrors)
      .where(eq(agentErrors.agentId, agentId))
      .limit(1)

    expect(errorRow!.severity).toBe(WHITELISTED_SEVERITY)
    expect((errorRow!.context as Record<string, unknown>)['whitelisted']).toBe(true)

    // Badge not affected.
    const result = await listAgents({ projectId })
    const agent = result.agents.find((a) => a.id === agentId)
    expect(agent!.errorCount24h).toBe(0)
  })

  // ── Task-report path (3rd ingress site) ─────────────────────────────

  it('task-report path: whitelisted error downgrades even though the site hardcodes severity=error', async () => {
    await clearErrors()
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })
    await updateFleetDefault({})

    // The task-report ingress assigns severity='error' to each reported item
    // BEFORE evaluating the whitelist, then downgrades — exactly what the route
    // loop does. This proves the hardcoded severity does not defeat the
    // whitelist at the 3rd site.
    const { resolveEffectiveWhitelist: resolveWL } =
      await import('../../src/services/agent-config.js')
    const { downgradeIfWhitelisted } = await import('../../src/services/agents/whitelist.js')

    const whitelist = await resolveWL(agentId)
    const reported = { severity: 'error', message: 'No hashes loaded' }
    const effective = downgradeIfWhitelisted(reported, whitelist)
    await logAgentError({ ...effective, agentId })

    const [errorRow] = await db
      .select()
      .from(agentErrors)
      .where(eq(agentErrors.agentId, agentId))
      .limit(1)

    expect(errorRow!.severity).toBe(WHITELISTED_SEVERITY)
    expect((errorRow!.context as Record<string, unknown>)['whitelisted']).toBe(true)

    // Badge not affected by the downgraded task-report error.
    const result = await listAgents({ projectId })
    const agent = result.agents.find((a) => a.id === agentId)
    expect(agent!.errorCount24h).toBe(0)
  })

  // ── Union whitelist (fleet + rig) ────────────────────────────────────

  it('union whitelist (fleet + rig) — patterns from both sources match and downgrade', async () => {
    await clearErrors()
    await resetAgentStatus('online')
    await updateFleetDefault({ errorWhitelist: ['fleet-pattern'] })
    await updateAgentConfig(agentId, { errorWhitelist: ['rig-pattern'] })

    // Both whitelisted via heartbeat.
    await processHeartbeat(agentId, {
      status: 'online',
      error: { severity: 'fatal', message: 'fleet-pattern hit' },
    })
    await processHeartbeat(agentId, {
      status: 'online',
      error: { severity: 'fatal', message: 'rig-pattern hit' },
    })

    const rows = await db.select().from(agentErrors).where(eq(agentErrors.agentId, agentId))
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.severity).toBe(WHITELISTED_SEVERITY)
      expect((row.context as Record<string, unknown>)['whitelisted']).toBe(true)
    }

    // Agent stays online, badge stays at 0.
    const [agentRow] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
    expect(agentRow!.status).toBe('online')

    const result = await listAgents({ projectId })
    const listed = result.agents.find((a) => a.id === agentId)
    expect(listed!.errorCount24h).toBe(0)
  })

  // ── R18: reviewRecommended signal ────────────────────────────────────

  it('reviewRecommended is false when whitelisted count is below threshold', async () => {
    await clearErrors()
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })
    await updateFleetDefault({})

    for (let i = 0; i < REVIEW_RECOMMENDED_THRESHOLD - 1; i++) {
      await logAgentError({
        agentId,
        severity: WHITELISTED_SEVERITY,
        message: 'No hashes loaded',
        context: { whitelisted: true },
      })
    }

    const result = await listAgents({ projectId })
    const agent = result.agents.find((a) => a.id === agentId)
    expect(agent!.reviewRecommended).toBe(false)
    expect(agent!.errorCount24h).toBe(0)
  })

  it('reviewRecommended is true when whitelisted count meets threshold (R18)', async () => {
    await clearErrors()
    await updateAgentConfig(agentId, { errorWhitelist: ['No hashes loaded'] })
    await updateFleetDefault({})

    for (let i = 0; i < REVIEW_RECOMMENDED_THRESHOLD; i++) {
      await logAgentError({
        agentId,
        severity: WHITELISTED_SEVERITY,
        message: 'No hashes loaded',
        context: { whitelisted: true },
      })
    }

    const result = await listAgents({ projectId })
    const agent = result.agents.find((a) => a.id === agentId)
    // R18: distinct from error status — healthy agent can have reviewRecommended=true.
    expect(agent!.reviewRecommended).toBe(true)
    expect(agent!.errorCount24h).toBe(0)
    expect(agent!.worstSeverity24h).toBeNull()
  })
})
