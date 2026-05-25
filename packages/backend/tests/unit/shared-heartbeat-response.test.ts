/**
 * Schema sanity tests for `agentHeartbeatResponseSchema` in
 * `@hashhive/shared`. The schema is the wire contract that the agent
 * route handler at `routes/agent/index.ts` must satisfy — these tests
 * pin the shape so a future shared-schema edit can't drift the agent
 * contract silently.
 *
 * Cross-package contract proof (route body ↔ OpenAPI spec) lives in
 * `agent-api-contract.test.ts`; this file just asserts the schema's
 * own parse behavior.
 */

import { agentHeartbeatResponseSchema } from '@hashhive/shared'
import { describe, expect, test } from 'bun:test'

describe('agentHeartbeatResponseSchema', () => {
  test('accepts { acknowledged: true } with no hasHighPriorityTasks', () => {
    const parsed = agentHeartbeatResponseSchema.parse({ acknowledged: true })
    expect(parsed.acknowledged).toBe(true)
    expect(parsed.hasHighPriorityTasks).toBeUndefined()
  })

  test('accepts { acknowledged: true, hasHighPriorityTasks: true }', () => {
    const parsed = agentHeartbeatResponseSchema.parse({
      acknowledged: true,
      hasHighPriorityTasks: true,
    })
    expect(parsed.hasHighPriorityTasks).toBe(true)
  })

  test('rejects acknowledged: false (must be literal true on a 200)', () => {
    expect(() => agentHeartbeatResponseSchema.parse({ acknowledged: false })).toThrow()
  })

  test('rejects non-boolean hasHighPriorityTasks', () => {
    expect(() =>
      agentHeartbeatResponseSchema.parse({
        acknowledged: true,
        hasHighPriorityTasks: 'yes',
      })
    ).toThrow()
  })

  test('rejects hasHighPriorityTasks: false (the wire policy is omit-when-false)', () => {
    // Mirrors the OpenAPI `enum: [true]` constraint on the field. The
    // server's route policy omits the key when there is no high-priority
    // work; emitting `false` would violate the published contract that
    // generated agent clients consume.
    expect(() =>
      agentHeartbeatResponseSchema.parse({
        acknowledged: true,
        hasHighPriorityTasks: false,
      })
    ).toThrow()
  })

  test('rejects missing acknowledged field', () => {
    expect(() => agentHeartbeatResponseSchema.parse({ hasHighPriorityTasks: true })).toThrow()
  })
})
