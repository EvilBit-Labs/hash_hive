/**
 * Unit tests for the scheduled health-monitor worker (issue #109).
 *
 * Tests target the pure tick function `runHealthMonitorTick` which takes
 * an injectable dependency bag — the BullMQ Worker / Redis / actual
 * service bindings live behind that bag and are not exercised here.
 */
import { describe, expect, test } from 'bun:test'

import type { ComponentHealth, ComponentName, ComponentStatus } from '../../src/services/health.js'

import {
  type HealthMonitorDeps,
  runHealthMonitorTick,
} from '../../src/queue/workers/health-monitor.js'

interface TestContext {
  /** In-memory cache state (authoritative for transition detection). */
  memory: Record<ComponentName, ComponentStatus | null>
  /** Redis-mirrored state (used only to seed memory after fresh boot). */
  redis: Record<ComponentName, ComponentStatus | null>
  broadcasts: Array<{ component: ComponentName; status: ComponentStatus; message?: string }>
  deps: HealthMonitorDeps
}

function makeComponent(status: ComponentStatus, message?: string): ComponentHealth {
  return { status, durationMs: 1, ...(message ? { message } : {}) }
}

interface BuildContextOptions {
  /** Initial in-memory state (post-boot worker has empty memory). */
  memory?: Partial<Record<ComponentName, ComponentStatus>>
  /** Initial Redis-backed state (seeded into memory on first cache miss). */
  redis?: Partial<Record<ComponentName, ComponentStatus>>
}

function buildContext(
  initial: BuildContextOptions,
  componentStatuses: Record<
    ComponentName,
    ComponentStatus | { status: ComponentStatus; message?: string }
  >
): TestContext {
  const memory: Record<ComponentName, ComponentStatus | null> = {
    database: initial.memory?.database ?? null,
    redis: initial.memory?.redis ?? null,
    object_store: initial.memory?.object_store ?? null,
    queues: initial.memory?.queues ?? null,
  }
  const redis: Record<ComponentName, ComponentStatus | null> = {
    database: initial.redis?.database ?? null,
    redis: initial.redis?.redis ?? null,
    object_store: initial.redis?.object_store ?? null,
    queues: initial.redis?.queues ?? null,
  }
  const broadcasts: TestContext['broadcasts'] = []
  const components: Record<ComponentName, ComponentHealth> = {
    database: parseStatus(componentStatuses.database),
    redis: parseStatus(componentStatuses.redis),
    object_store: parseStatus(componentStatuses.object_store),
    queues: parseStatus(componentStatuses.queues),
  }

  const deps: HealthMonitorDeps = {
    readMemoryStatus: (component) => memory[component],
    writeMemoryStatus: (component, status) => {
      memory[component] = status
    },
    readRedisStatus: async (component) => redis[component],
    writeRedisStatus: async (component, status) => {
      redis[component] = status
    },
    broadcast: (component, status, message) => {
      broadcasts.push({ component, status, ...(message ? { message } : {}) })
    },
    fetchHealth: async () => ({ components }),
  }

  return { memory, redis, broadcasts, deps }
}

function parseStatus(
  s: ComponentStatus | { status: ComponentStatus; message?: string }
): ComponentHealth {
  if (typeof s === 'string') return makeComponent(s)
  return makeComponent(s.status, s.message)
}

describe('runHealthMonitorTick', () => {
  test('first run with no prior state seeds memory and emits zero broadcasts', async () => {
    const ctx = buildContext(
      {}, // no prior state in memory or Redis
      { database: 'healthy', redis: 'healthy', object_store: 'healthy', queues: 'healthy' }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned).toEqual([])
    expect(result.initialized.sort()).toEqual(['database', 'object_store', 'queues', 'redis'])
    expect(ctx.broadcasts).toHaveLength(0)

    // Both memory and Redis are seeded
    expect(ctx.memory.database).toBe('healthy')
    expect(ctx.memory.queues).toBe('healthy')
    expect(ctx.redis.database).toBe('healthy')
  })

  test('post-boot tick with empty memory but populated Redis seeds without broadcasting', async () => {
    // Worker just restarted: memory is empty, but Redis still has prior state.
    // The first tick should treat current === redis as unchanged (no broadcast)
    // rather than a fresh-init "everything new" volley.
    const ctx = buildContext(
      {
        memory: {}, // empty post-boot
        redis: {
          database: 'healthy',
          redis: 'healthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      { database: 'healthy', redis: 'healthy', object_store: 'healthy', queues: 'healthy' }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned).toEqual([])
    expect(result.unchanged.sort()).toEqual(['database', 'object_store', 'queues', 'redis'])
    expect(ctx.broadcasts).toHaveLength(0)
  })

  test('second run with identical status emits zero broadcasts', async () => {
    const ctx = buildContext(
      {
        memory: {
          database: 'healthy',
          redis: 'healthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      { database: 'healthy', redis: 'healthy', object_store: 'healthy', queues: 'healthy' }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned).toEqual([])
    expect(result.unchanged.sort()).toEqual(['database', 'object_store', 'queues', 'redis'])
    expect(ctx.broadcasts).toHaveLength(0)
  })

  test('one component flips from healthy to degraded — exactly one broadcast', async () => {
    const ctx = buildContext(
      {
        memory: {
          database: 'healthy',
          redis: 'healthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      {
        database: { status: 'degraded', message: 'pool 90% full' },
        redis: 'healthy',
        object_store: 'healthy',
        queues: 'healthy',
      }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned).toEqual(['database'])
    expect(ctx.broadcasts).toHaveLength(1)
    expect(ctx.broadcasts[0]).toEqual({
      component: 'database',
      status: 'degraded',
      message: 'pool 90% full',
    })
    expect(ctx.memory.database).toBe('degraded')
    // Other components stayed healthy
    expect(ctx.memory.queues).toBe('healthy')
  })

  test('two components flip simultaneously — exactly two broadcasts', async () => {
    const ctx = buildContext(
      {
        memory: {
          database: 'healthy',
          redis: 'healthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      {
        database: 'degraded',
        redis: 'unhealthy',
        object_store: 'healthy',
        queues: 'healthy',
      }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned.sort()).toEqual(['database', 'redis'])
    expect(ctx.broadcasts).toHaveLength(2)
    const components = ctx.broadcasts.map((b) => b.component).sort()
    expect(components).toEqual(['database', 'redis'])
  })

  test('all four components flip simultaneously — four broadcasts (testing T-008 / U5)', async () => {
    const ctx = buildContext(
      {
        memory: {
          database: 'healthy',
          redis: 'healthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      {
        database: 'unhealthy',
        redis: 'unhealthy',
        object_store: 'unhealthy',
        queues: 'unhealthy',
      }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned.sort()).toEqual(['database', 'object_store', 'queues', 'redis'])
    expect(ctx.broadcasts).toHaveLength(4)
  })

  test('component flips back from unhealthy to healthy — broadcast on recovery', async () => {
    const ctx = buildContext(
      {
        memory: {
          database: 'healthy',
          redis: 'unhealthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      { database: 'healthy', redis: 'healthy', object_store: 'healthy', queues: 'healthy' }
    )

    const result = await runHealthMonitorTick(ctx.deps)

    expect(result.transitioned).toEqual(['redis'])
    expect(ctx.broadcasts[0]?.status).toBe('healthy')
  })

  test('full Redis healthy → unhealthy → recovered cycle emits both transitions even when Redis read/write fails (C1 regression)', async () => {
    // Setup: persistent in-memory cache across simulated ticks; Redis fails
    // both reads and writes (simulating Redis itself being the unhealthy
    // component). The transition-detection signal must survive the outage.
    const memory = new Map<ComponentName, ComponentStatus>([
      ['database', 'healthy'],
      ['redis', 'healthy'],
      ['object_store', 'healthy'],
      ['queues', 'healthy'],
    ])
    const broadcasts: TestContext['broadcasts'] = []

    function depsForCurrent(
      components: Record<ComponentName, ComponentHealth>,
      redisFails: boolean
    ): HealthMonitorDeps {
      return {
        readMemoryStatus: (c) => memory.get(c) ?? null,
        writeMemoryStatus: (c, s) => {
          memory.set(c, s)
        },
        readRedisStatus: async () => {
          if (redisFails) throw new Error('redis ECONNREFUSED')
          return null
        },
        writeRedisStatus: async () => {
          if (redisFails) throw new Error('redis ECONNREFUSED')
        },
        broadcast: (c, s, m) =>
          broadcasts.push({ component: c, status: s, ...(m ? { message: m } : {}) }),
        fetchHealth: async () => ({ components }),
      }
    }

    // Tick 1: Redis goes down. Probe reports redis=unhealthy.
    await runHealthMonitorTick(
      depsForCurrent(
        {
          database: makeComponent('healthy'),
          redis: makeComponent('unhealthy', 'redis disconnected'),
          object_store: makeComponent('healthy'),
          queues: makeComponent('unhealthy', 'queue manager not connected to redis'),
        },
        true
      )
    )
    // Tick 2: Redis still down. Same status. No new broadcasts.
    await runHealthMonitorTick(
      depsForCurrent(
        {
          database: makeComponent('healthy'),
          redis: makeComponent('unhealthy', 'redis disconnected'),
          object_store: makeComponent('healthy'),
          queues: makeComponent('unhealthy', 'queue manager not connected to redis'),
        },
        true
      )
    )
    // Tick 3: Redis recovers.
    await runHealthMonitorTick(
      depsForCurrent(
        {
          database: makeComponent('healthy'),
          redis: makeComponent('healthy'),
          object_store: makeComponent('healthy'),
          queues: makeComponent('healthy'),
        },
        false
      )
    )

    // Two transitions for redis: healthy→unhealthy (tick 1), unhealthy→healthy (tick 3).
    // Two transitions for queues: healthy→unhealthy (tick 1), unhealthy→healthy (tick 3).
    const redisBroadcasts = broadcasts.filter((b) => b.component === 'redis')
    expect(redisBroadcasts).toHaveLength(2)
    expect(redisBroadcasts[0]?.status).toBe('unhealthy')
    expect(redisBroadcasts[1]?.status).toBe('healthy')
    const queuesBroadcasts = broadcasts.filter((b) => b.component === 'queues')
    expect(queuesBroadcasts).toHaveLength(2)
  })

  test('Redis read failure on first-tick post-boot is logged but treated as no prior state', async () => {
    const broadcasts: TestContext['broadcasts'] = []
    const deps: HealthMonitorDeps = {
      readMemoryStatus: () => null,
      writeMemoryStatus: () => {},
      readRedisStatus: async () => {
        throw new Error('redis ECONNREFUSED')
      },
      writeRedisStatus: async () => {},
      broadcast: (component, status, message) => {
        broadcasts.push({ component, status, ...(message ? { message } : {}) })
      },
      fetchHealth: async () => ({
        components: {
          database: makeComponent('healthy'),
          redis: makeComponent('unhealthy', 'connection refused'),
          object_store: makeComponent('healthy'),
          queues: makeComponent('healthy'),
        },
      }),
    }

    const result = await runHealthMonitorTick(deps)
    // Treated as initialized (no prior state) — no broadcast
    expect(result.initialized).toContain('redis')
    expect(broadcasts).toHaveLength(0)
  })

  test('Redis write failure is logged but does not crash the worker', async () => {
    const ctx = buildContext(
      { memory: { database: 'healthy' } },
      { database: 'degraded', redis: 'healthy', object_store: 'healthy', queues: 'healthy' }
    )
    // Override writeRedisStatus to throw — memory write still succeeds
    const deps: HealthMonitorDeps = {
      ...ctx.deps,
      writeRedisStatus: async () => {
        throw new Error('redis disconnected during write')
      },
    }

    const result = await runHealthMonitorTick(deps)

    expect(result.transitioned).toContain('database')
    expect(ctx.broadcasts).toHaveLength(1)
    // Memory was still updated despite Redis write failure
    expect(ctx.memory.database).toBe('degraded')
  })

  test('broadcast throw on one component does not stop the loop (T-009)', async () => {
    const ctx = buildContext(
      {
        memory: {
          database: 'healthy',
          redis: 'healthy',
          object_store: 'healthy',
          queues: 'healthy',
        },
      },
      {
        database: 'degraded',
        redis: 'degraded',
        object_store: 'healthy',
        queues: 'healthy',
      }
    )
    let firstCall = true
    const deps: HealthMonitorDeps = {
      ...ctx.deps,
      broadcast: (component, status, message) => {
        if (firstCall) {
          firstCall = false
          throw new Error('synthetic broadcast failure')
        }
        ctx.broadcasts.push({ component, status, ...(message ? { message } : {}) })
      },
    }

    const result = await runHealthMonitorTick(deps)

    // Both components still appear in transitioned (loop continued)
    expect(result.transitioned.sort()).toEqual(['database', 'redis'])
    // Memory was updated for both despite first broadcast throwing
    expect(ctx.memory.database).toBe('degraded')
    expect(ctx.memory.redis).toBe('degraded')
  })

  test('getSystemHealth rejection is swallowed; tick result is marked skipped', async () => {
    const broadcasts: TestContext['broadcasts'] = []
    const deps: HealthMonitorDeps = {
      readMemoryStatus: () => null,
      writeMemoryStatus: () => {},
      readRedisStatus: async () => null,
      writeRedisStatus: async () => {},
      broadcast: (component, status, message) => {
        broadcasts.push({ component, status, ...(message ? { message } : {}) })
      },
      fetchHealth: async () => {
        throw new Error('catastrophic probe failure')
      },
    }

    const result = await runHealthMonitorTick(deps)

    expect(result.transitioned).toEqual([])
    expect(result.initialized).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.skipped).toEqual({ reason: 'getSystemHealth threw' })
    expect(broadcasts).toHaveLength(0)
  })

  test('forwards component message into broadcast payload on transition', async () => {
    const ctx = buildContext(
      { memory: { queues: 'healthy' } },
      {
        queues: { status: 'degraded', message: 'tasks-high waiting=50000 > 10000' },
        database: 'healthy',
        redis: 'healthy',
        object_store: 'healthy',
      }
    )

    await runHealthMonitorTick(ctx.deps)

    const queueBroadcast = ctx.broadcasts.find((b) => b.component === 'queues')
    expect(queueBroadcast?.message).toBe('tasks-high waiting=50000 > 10000')
  })
})
