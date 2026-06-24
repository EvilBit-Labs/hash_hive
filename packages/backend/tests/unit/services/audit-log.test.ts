/**
 * Unit tests for `recordAuditEvent` (issue #105 / U2).
 *
 * Runs in an isolated bun:test phase (AUDIT_LOG_TEST_ISOLATED=1) because
 * the `mock.module` call replaces `db` process-wide and would poison sibling
 * test files in the shared bun:test cache. Mirrors the env-gate + skip-stub
 * pattern from `tests/unit/services/telemetry.test.ts`.
 *
 * Verifies:
 *   - R6: secret/credential fields never appear in `changes`
 *   - Fail-closed: fields absent from the allowlist are dropped even without
 *     a denylist entry
 *   - Drift guard: every column on each audited table is accounted for
 *   - Size cap: oversized changes are replaced with { _truncated: true }
 *   - Diff shape: updated / created / deleted / token_issued
 *   - Executor forwarding: a custom executor (e.g. tx) is used, errors propagate
 *
 * The db layer is mocked with a values-capturing insert so no real connection
 * is needed.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['AUDIT_LOG_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('audit-log (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[audit-log] skipped — set AUDIT_LOG_TEST_ISOLATED=1 to run; the audit-log recorder suite did NOT execute in this phase.'
      )
      expect(process.env['AUDIT_LOG_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── Type helper (local, not exported) ─────────────────────────────────────
  type ChangedField = { old?: unknown; new?: unknown }

  // ─── db mock (must precede the import of the module under test) ────────────

  let capturedValues: Record<string, unknown> | undefined
  const returningMock = mock(() => Promise.resolve([{ id: 1 }]))
  const valuesMock = mock((v: Record<string, unknown>) => {
    capturedValues = v
    return { returning: returningMock }
  })
  const insertMock = mock(() => ({ values: valuesMock }))

  mock.module('../../../src/db/index.js', () => ({
    db: { insert: insertMock },
  }))

  // ─── Module under test ─────────────────────────────────────────────────────

  const {
    recordAuditEvent,
    ENTITY_ALLOWLISTS,
    AUDITED_TABLE_COLUMNS,
    EXPLICITLY_EXCLUDED_COLUMNS,
  } = await import('../../../src/services/audit-log.js')

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function makeExecutor() {
    const executorReturning = mock(() => Promise.resolve([{ id: 99 }]))
    const executorValues = mock(() => ({ returning: executorReturning }))
    const executorInsert = mock(() => ({ values: executorValues }))
    return { insert: executorInsert, executorReturning, executorValues, executorInsert }
  }

  const baseActor = { actorType: 'user' as const, actorId: 7 }
  const baseInput = {
    actor: baseActor,
    projectId: 1,
    entityType: 'agent' as const,
    entityId: 42,
    action: 'updated' as const,
  }

  beforeEach(() => {
    capturedValues = undefined
    valuesMock.mockClear()
    insertMock.mockClear()
    returningMock.mockReset().mockImplementation(() => Promise.resolve([{ id: 1 }]))
  })

  // ─── R6: secret fields never appear in changes ───────────────────────────────

  describe('R6: agent secret fields are excluded from changes', () => {
    it('strips authTokenHash and legacy authToken from agent old/new rows', async () => {
      const oldRow = {
        id: 42,
        name: 'rig-01',
        projectId: 1,
        authToken: 'plaintext-bearer-value',
        authTokenHash: '$2b$12$secrethashvalue',
        authTokenFormat: 'bcrypt',
        status: 'offline',
        capabilities: {},
        crackerVersion: null,
        enrollmentClientId: null,
        lastSeenAt: null,
        hardwareProfile: {},
        operatingSystemId: null,
        enrolledByTokenId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const newRow = {
        ...oldRow,
        name: 'rig-01-renamed',
        authToken: 'plaintext-bearer-value', // unchanged but still must be stripped
        authTokenHash: '$2b$12$differenthash', // changed but must be stripped
      }

      await recordAuditEvent({
        ...baseInput,
        oldRow,
        newRow,
      })

      const changes = capturedValues?.changes as Record<string, unknown> | null
      expect(changes).not.toBeNull()

      const changedKeys = Object.keys(changes ?? {})
      expect(changedKeys).not.toContain('authToken')
      expect(changedKeys).not.toContain('authTokenHash')
      expect(changedKeys).not.toContain('authTokenFormat')

      // The allowed change (name) IS present
      expect(changedKeys).toContain('name')

      // Values must not appear either
      const serialized = JSON.stringify(changes)
      expect(serialized).not.toContain('plaintext-bearer-value')
      expect(serialized).not.toContain('secrethashvalue')
      expect(serialized).not.toContain('differenthash')
    })

    it('strips operational fields: lastSeenAt, hardwareProfile', async () => {
      const oldRow = {
        id: 42,
        name: 'rig-01',
        projectId: 1,
        authToken: null,
        authTokenHash: null,
        authTokenFormat: 'plaintext',
        status: 'offline',
        capabilities: {},
        crackerVersion: null,
        enrollmentClientId: null,
        lastSeenAt: new Date('2026-01-01'),
        hardwareProfile: { gpu: 'RTX 4090', fingerprint: 'abc123' },
        operatingSystemId: 3,
        enrolledByTokenId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const newRow = {
        ...oldRow,
        lastSeenAt: new Date('2026-06-01'), // changed but operational — must be stripped
        status: 'online', // changed and on allowlist — must appear
      }

      await recordAuditEvent({ ...baseInput, oldRow, newRow })

      const changes = capturedValues?.changes as Record<string, unknown> | null
      const changedKeys = Object.keys(changes ?? {})
      expect(changedKeys).not.toContain('lastSeenAt')
      expect(changedKeys).not.toContain('hardwareProfile')
      expect(changedKeys).not.toContain('operatingSystemId')
      expect(changedKeys).toContain('status')
    })
  })

  // ─── Fail-closed: non-allowlisted fields are dropped ─────────────────────────

  describe('fail-closed allowlist', () => {
    it('drops a field not on the allowlist even when no denylist entry names it', async () => {
      // Simulate a newly added column `internalNote` not yet on the allowlist.
      const oldRow = {
        id: 1,
        name: 'Ops Project',
        description: null,
        slug: 'ops',
        settings: {},
        createdBy: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        internalNote: 'sensitive planning note', // NEW, not on allowlist
      }
      const newRow = {
        ...oldRow,
        internalNote: 'updated planning note', // changed, but not allowlisted
        name: 'Ops Project v2', // changed and allowlisted
      }

      await recordAuditEvent({
        ...baseInput,
        entityType: 'project',
        oldRow,
        newRow,
      })

      const changes = capturedValues?.changes as Record<string, unknown> | null
      const keys = Object.keys(changes ?? {})
      expect(keys).not.toContain('internalNote')
      expect(keys).toContain('name')
    })
  })

  // ─── Drift guard ─────────────────────────────────────────────────────────────

  describe('allowlist drift guard', () => {
    it('every column on each audited table is on either its allowlist or EXPLICITLY_EXCLUDED_COLUMNS', () => {
      const unaccounted: Record<string, string[]> = {}

      for (const [entityType, columns] of Object.entries(AUDITED_TABLE_COLUMNS) as Array<
        [string, ReadonlySet<string>]
      >) {
        const allowed = ENTITY_ALLOWLISTS[entityType as keyof typeof ENTITY_ALLOWLISTS]
        const missing: string[] = []

        for (const col of columns) {
          if (!allowed.has(col) && !EXPLICITLY_EXCLUDED_COLUMNS.has(col)) {
            missing.push(col)
          }
        }

        if (missing.length > 0) {
          unaccounted[entityType] = missing
        }
      }

      if (Object.keys(unaccounted).length > 0) {
        const report = Object.entries(unaccounted)
          .map(([entity, cols]) => `  ${entity}: [${cols.join(', ')}]`)
          .join('\n')
        throw new Error(
          `Columns not accounted for (add to allowlist or EXPLICITLY_EXCLUDED_COLUMNS):\n${report}`
        )
      }
    })
  })

  // ─── Size cap ────────────────────────────────────────────────────────────────

  describe('changes size cap', () => {
    it('replaces oversized changes with { _truncated: true }', async () => {
      // Build a large value that exceeds 64 KB when serialized.
      const largeString = 'x'.repeat(70 * 1024)

      const oldRow = {
        id: 1,
        projectId: 1,
        name: 'old name',
        description: null,
        slug: 'proj',
        settings: {},
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const newRow = {
        ...oldRow,
        description: largeString, // triggers size cap
      }

      await recordAuditEvent({
        ...baseInput,
        entityType: 'project',
        oldRow,
        newRow,
      })

      const changes = capturedValues?.changes as Record<string, unknown> | null
      expect(changes).toEqual({ _truncated: true })
    })

    it('stores the diff normally when it is under the size cap', async () => {
      const oldRow = {
        id: 1,
        projectId: 1,
        name: 'old',
        description: null,
        slug: 'proj',
        settings: {},
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const newRow = { ...oldRow, name: 'new' }

      await recordAuditEvent({
        ...baseInput,
        entityType: 'project',
        oldRow,
        newRow,
      })

      const changes = capturedValues?.changes as Record<string, unknown> | null
      expect(changes).not.toEqual({ _truncated: true })
      expect(changes).toHaveProperty('name')
    })
  })

  // ─── Diff shape ───────────────────────────────────────────────────────────────

  describe('diff shape', () => {
    it('updated: records exactly the 3 changed allowlisted fields and omits the 2 unchanged', async () => {
      const base = {
        id: 1,
        projectId: 1,
        name: 'Campaign A',
        description: 'original',
        hashListId: 10,
        status: 'draft',
        isPermanent: false,
        priority: 5,
        progress: { percent: 0 },
        metadata: {},
        createdBy: 1,
        startedAt: null,
        completedAt: null,
        archivedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const oldRow = base
      const newRow = {
        ...base,
        name: 'Campaign A v2', // changed — allowlisted
        priority: 8, // changed — allowlisted
        progress: { percent: 50 }, // changed — allowlisted (jsonb by value)
        // description and metadata are UNCHANGED — must not appear
      }

      await recordAuditEvent({
        ...baseInput,
        entityType: 'campaign',
        action: 'updated',
        oldRow,
        newRow,
      })

      const changes = capturedValues?.changes as Record<string, ChangedField> | null
      expect(changes).not.toBeNull()
      const keys = Object.keys(changes ?? {})

      expect(keys).toContain('name')
      expect(keys).toContain('priority')
      expect(keys).toContain('progress')
      expect(keys).not.toContain('description')
      expect(keys).not.toContain('metadata')
      expect(keys).toHaveLength(3)

      // Both old and new are present on each changed field
      // changes is asserted non-null above; cast to access properties safely
      const c = changes as Record<string, ChangedField>
      expect((c.name as ChangedField).old).toBe('Campaign A')
      expect((c.name as ChangedField).new).toBe('Campaign A v2')
      expect((c.priority as ChangedField).old).toBe(5)
      expect((c.priority as ChangedField).new).toBe(8)
    })

    it('created: records a new-value snapshot (no old)', async () => {
      const newRow = {
        id: 1,
        projectId: 1,
        name: 'My Project',
        description: null,
        slug: 'my-project',
        settings: {},
        createdBy: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      await recordAuditEvent({
        ...baseInput,
        entityType: 'project',
        action: 'created',
        oldRow: null,
        newRow,
      })

      const changes = capturedValues?.changes as Record<string, ChangedField> | null
      expect(changes).not.toBeNull()
      // changes is asserted non-null above; cast to access properties safely
      const c = changes as Record<string, ChangedField>
      // Every allowlisted field in newRow has { new: value }
      expect((c.name as ChangedField).new).toBe('My Project')
      expect(c.name as ChangedField).not.toHaveProperty('old')
      // createdAt and updatedAt are excluded (not on allowlist)
      expect(changes).not.toHaveProperty('createdAt')
    })

    it('deleted: records an old-value snapshot (no new)', async () => {
      const oldRow = {
        id: 5,
        projectId: 1,
        name: 'Deleted Project',
        description: 'gone',
        slug: 'gone',
        settings: {},
        createdBy: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      await recordAuditEvent({
        ...baseInput,
        entityType: 'project',
        action: 'deleted',
        oldRow,
        newRow: null,
      })

      const changes = capturedValues?.changes as Record<string, ChangedField> | null
      expect(changes).not.toBeNull()
      // changes is asserted non-null above; cast to access properties safely
      const c = changes as Record<string, ChangedField>
      expect((c.name as ChangedField).old).toBe('Deleted Project')
      expect(c.name as ChangedField).not.toHaveProperty('new')
    })

    it('token_issued: changes is null', async () => {
      await recordAuditEvent({
        ...baseInput,
        action: 'token_issued',
        oldRow: { id: 1, name: 'agent', authToken: 'secret-token', authTokenHash: 'hash' },
        newRow: { id: 1, name: 'agent', authToken: 'secret-token', authTokenHash: 'hash' },
      })

      expect(capturedValues?.changes).toBeNull()
    })
  })

  // ─── Executor forwarding ─────────────────────────────────────────────────────

  describe('executor', () => {
    it('uses the supplied executor rather than the module db', async () => {
      const executor = makeExecutor()

      await recordAuditEvent(
        {
          ...baseInput,
          entityType: 'project',
          action: 'created',
          newRow: {
            id: 1,
            name: 'P',
            description: null,
            slug: 'p',
            settings: {},
            createdBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { insert: executor.executorInsert }
      )

      // The custom executor was used
      expect(executor.executorInsert).toHaveBeenCalledTimes(1)
      // The module-level mock was NOT used
      expect(insertMock).not.toHaveBeenCalled()
    })

    it('propagates a DB insert failure to the caller (does not swallow)', async () => {
      returningMock.mockReset().mockImplementation(() => Promise.reject(new Error('db blip')))

      await expect(
        recordAuditEvent({
          ...baseInput,
          entityType: 'project',
          action: 'updated',
          oldRow: {
            id: 1,
            name: 'old',
            description: null,
            slug: 'p',
            settings: {},
            createdBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          newRow: {
            id: 1,
            name: 'new',
            description: null,
            slug: 'p',
            settings: {},
            createdBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
      ).rejects.toThrow('db blip')
    })
  })
}
