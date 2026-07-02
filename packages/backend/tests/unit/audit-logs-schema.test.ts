/**
 * Drift-guard unit tests for the audit_logs table (#105 / U1).
 *
 * These tests assert that:
 * 1. Every Zod enum value appears in the corresponding DB CHECK constraint
 *    IN-list (schema.ts const arrays), so the vocabulary can never silently
 *    diverge between the wire validator and the DB enforcement.
 * 2. auditLogSchema.parse() round-trips a representative row including a
 *    populated `changes` diff and optional label fields.
 *
 * Pattern: compare the Zod enum values against the const arrays exported from
 * `@hashhive/shared` db/schema.ts. The check constraint SQL is generated
 * from those same arrays, so this test is an exact proxy for "the constraint
 * IN-list and the enum match".
 */

import {
  AUDIT_ACTION_VALUES,
  AUDIT_ACTOR_TYPE_VALUES,
  AUDIT_ENTITY_TYPE_VALUES,
  auditActionSchema,
  auditActorTypeSchema,
  auditEntityTypeSchema,
  auditLogSchema,
} from '@hashhive/shared'
import { describe, expect, it } from 'bun:test'

// ─── Vocab drift guards ──────────────────────────────────────────────────────

describe('audit_logs vocab drift guard', () => {
  it('auditActorTypeSchema enum values match AUDIT_ACTOR_TYPE_VALUES', () => {
    // Every Zod option appears in the DB const (and vice versa).
    const zodValues = auditActorTypeSchema.options as readonly string[]
    const dbValues: readonly string[] = AUDIT_ACTOR_TYPE_VALUES

    expect([...zodValues].toSorted()).toEqual([...dbValues].toSorted())
  })

  it('auditEntityTypeSchema enum values match AUDIT_ENTITY_TYPE_VALUES', () => {
    const zodValues = auditEntityTypeSchema.options as readonly string[]
    const dbValues: readonly string[] = AUDIT_ENTITY_TYPE_VALUES

    expect([...zodValues].toSorted()).toEqual([...dbValues].toSorted())
  })

  it('auditActionSchema enum values match AUDIT_ACTION_VALUES', () => {
    const zodValues = auditActionSchema.options as readonly string[]
    const dbValues: readonly string[] = AUDIT_ACTION_VALUES

    expect([...zodValues].toSorted()).toEqual([...dbValues].toSorted())
  })

  it('AUDIT_ACTION_VALUES includes the lifecycle verbs added in U1', () => {
    const lifecycleVerbs = ['archived', 'restored', 'retired', 'reclaimed'] as const
    for (const verb of lifecycleVerbs) {
      expect(AUDIT_ACTION_VALUES).toContain(verb)
    }
  })

  it('auditActionSchema accepts each new lifecycle verb', () => {
    const lifecycleVerbs = ['archived', 'restored', 'retired', 'reclaimed'] as const
    for (const verb of lifecycleVerbs) {
      expect(() => auditActionSchema.parse(verb)).not.toThrow()
      expect(auditActionSchema.parse(verb)).toBe(verb)
    }
  })

  it('auditActionSchema still rejects an unknown verb', () => {
    expect(() => auditActionSchema.parse('purged')).toThrow()
  })
})

// ─── auditLogSchema round-trip ───────────────────────────────────────────────

describe('auditLogSchema.parse()', () => {
  it('accepts a fully-populated representative row', () => {
    const raw = {
      id: 1,
      actorType: 'user',
      actorId: 7,
      projectId: 3,
      entityType: 'campaign',
      entityId: 42,
      action: 'status_changed',
      fromStatus: 'pending',
      toStatus: 'running',
      reason: 'Manually started',
      // changes is a permissive record at U1 — any shape is accepted.
      changes: { before: { status: 'pending' }, after: { status: 'running' } },
      createdAt: '2026-06-24T12:00:00.000Z',
      actorLabel: 'alice',
      entityLabel: 'Summer Campaign',
    }

    const parsed = auditLogSchema.parse(raw)

    expect(parsed.id).toBe(1)
    expect(parsed.actorType).toBe('user')
    expect(parsed.actorId).toBe(7)
    expect(parsed.projectId).toBe(3)
    expect(parsed.entityType).toBe('campaign')
    expect(parsed.entityId).toBe(42)
    expect(parsed.action).toBe('status_changed')
    expect(parsed.fromStatus).toBe('pending')
    expect(parsed.toStatus).toBe('running')
    expect(parsed.reason).toBe('Manually started')
    expect(parsed.changes).toEqual({ before: { status: 'pending' }, after: { status: 'running' } })
    expect(parsed.createdAt).toBe('2026-06-24T12:00:00.000Z')
    expect(parsed.actorLabel).toBe('alice')
    expect(parsed.entityLabel).toBe('Summer Campaign')
  })

  it('accepts a minimal row (nullable fields null, required labels present)', () => {
    // actorLabel / entityLabel are now required — the service always populates
    // them with a fallback string ('[deleted user]', '[deleted]', 'System', …).
    const raw = {
      id: 2,
      actorType: 'system',
      actorId: null,
      projectId: null,
      entityType: 'agent',
      entityId: 99,
      action: 'deleted',
      fromStatus: null,
      toStatus: null,
      reason: null,
      changes: null,
      createdAt: '2026-06-24T00:00:00.000Z',
      actorLabel: 'System',
      entityLabel: '[deleted]',
    }

    const parsed = auditLogSchema.parse(raw)

    expect(parsed.actorId).toBeNull()
    expect(parsed.projectId).toBeNull()
    expect(parsed.changes).toBeNull()
    expect(parsed.actorLabel).toBe('System')
    expect(parsed.entityLabel).toBe('[deleted]')
  })

  it('rejects an invalid actorType', () => {
    const raw = {
      id: 3,
      actorType: 'robot',
      actorId: null,
      projectId: null,
      entityType: 'agent',
      entityId: 1,
      action: 'created',
      fromStatus: null,
      toStatus: null,
      reason: null,
      changes: null,
      createdAt: '2026-06-24T00:00:00.000Z',
      actorLabel: 'System',
      entityLabel: '[deleted]',
    }

    expect(() => auditLogSchema.parse(raw)).toThrow()
  })

  it('rejects an invalid entityType', () => {
    const raw = {
      id: 4,
      actorType: 'user',
      actorId: 1,
      projectId: null,
      entityType: 'unknown_thing',
      entityId: 1,
      action: 'created',
      fromStatus: null,
      toStatus: null,
      reason: null,
      changes: null,
      createdAt: '2026-06-24T00:00:00.000Z',
      actorLabel: 'System',
      entityLabel: '[deleted]',
    }

    expect(() => auditLogSchema.parse(raw)).toThrow()
  })

  it('rejects an invalid action', () => {
    const raw = {
      id: 5,
      actorType: 'user',
      actorId: 1,
      projectId: null,
      entityType: 'campaign',
      entityId: 1,
      action: 'exploded',
      fromStatus: null,
      toStatus: null,
      reason: null,
      changes: null,
      createdAt: '2026-06-24T00:00:00.000Z',
      actorLabel: 'System',
      entityLabel: '[deleted]',
    }

    expect(() => auditLogSchema.parse(raw)).toThrow()
  })
})
