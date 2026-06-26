/**
 * #233 / #114 U3 — enrollment-token service (mint / list / revoke + the
 * security-critical atomic claim).
 *
 * Runs in an isolated bun:test phase (ENROLLMENT_TOKENS_TEST_ISOLATED=1)
 * because the `mock.module` calls replace `db` and the token libs
 * process-wide and would poison sibling test files in the shared bun:test
 * cache. Mirrors the env-gate + skip-stub pattern in
 * `tests/unit/services/preemption.test.ts`.
 *
 * The drizzle client is mocked at the chain level (the established
 * convention here): each `select`/`insert(...).returning()`/
 * `update(...).returning()` resolves to the next queued result set, and
 * `db.transaction(cb)` runs `cb` against the same chain mock.
 *
 * COVERAGE BOUNDARY (for security review): these tests prove the service's
 * decision logic — parse, verify, idempotent-retry, consume-zero
 * classification, conflict abort. They do NOT prove Postgres-level
 * atomicity. The single-use / max_uses guarantee and the no-duplicate-
 * agent guarantee are enforced by the guarded `UPDATE ... WHERE
 * (not exhausted/expired/revoked) RETURNING` and the partial unique index
 * on `agents(project_id, enrollment_client_id)` — DB mechanisms a mock
 * cannot exercise. CI provides no Postgres, matching the existing
 * tests/integration convention; the guard's correctness is argued in the
 * service doc comment and must be validated at the DB level.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['ENROLLMENT_TOKENS_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  describe('enrollment-tokens (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      // oxlint-disable-next-line no-console -- surface phase-gating drift in CI logs
      console.warn(
        '[enrollment-tokens] skipped — set ENROLLMENT_TOKENS_TEST_ISOLATED=1 to run; the enrollment-token service suite did NOT execute in this phase.'
      )
      expect(process.env['ENROLLMENT_TOKENS_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // ─── chain mock ─────────────────────────────────────────────────────
  let selectQueue: unknown[][] = []
  let insertReturningQueue: unknown[][] = []
  let updateReturningQueue: unknown[][] = []
  let capturedUpdateSets: Record<string, unknown>[] = []

  const selectMock = mock(() => {
    const result = selectQueue.shift() ?? []
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) chain[m] = () => chain
    // oxlint-disable-next-line unicorn/no-thenable -- intentional test double
    chain['then'] = (resolve: (v: unknown) => void) => resolve(result)
    return chain
  })

  const insertMock = mock(() => {
    const chain: Record<string, unknown> = {}
    chain['values'] = () => chain
    chain['onConflictDoNothing'] = () => chain
    chain['returning'] = () => Promise.resolve(insertReturningQueue.shift() ?? [])
    return chain
  })

  const updateMock = mock(() => {
    const chain: Record<string, unknown> = {}
    chain['set'] = (payload: Record<string, unknown>) => {
      capturedUpdateSets.push(payload)
      return chain
    }
    chain['where'] = () => chain
    chain['returning'] = () => Promise.resolve(updateReturningQueue.shift() ?? [])
    // Direct-await updates (lastUsedAt bump, bearer write) have no
    // .returning(); resolve undefined without touching the returning queue.
    // oxlint-disable-next-line unicorn/no-thenable -- intentional test double
    chain['then'] = (resolve: (v: unknown) => void) => resolve(undefined)
    return chain
  })

  const dbMock: Record<string, unknown> = {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  }
  dbMock['transaction'] = mock((cb: (t: typeof dbMock) => unknown) => cb(dbMock))

  mock.module('../../../src/db/index.js', () => ({ db: dbMock }))

  // Token libs mocked so the service logic is isolated from bcrypt; the
  // real lib is covered by tests/unit/enrollment-token.test.ts.
  let parseResult: { tokenId: number; secret: string } | null = null
  let verifyResult = true
  const generateEnrollmentTokenMock = mock((id: number) =>
    Promise.resolve({ token: `etk_${id}_brave-coral-otter-47`, hash: `EHASH-${id}` })
  )
  mock.module('../../../src/lib/enrollment-token.js', () => ({
    parseEnrollmentToken: mock(() => parseResult),
    verifyEnrollmentTokenHash: mock(() => Promise.resolve(verifyResult)),
    generateEnrollmentToken: generateEnrollmentTokenMock,
    ENROLLMENT_TOKEN_PREFIX: 'etk',
    ENROLLMENT_TOKEN_BCRYPT_COST: 12,
  }))

  const generateAgentTokenMock = mock((id: number) =>
    Promise.resolve({ token: `agt_${id}_rand`, hash: `AHASH-${id}` })
  )
  mock.module('../../../src/lib/agent-token.js', () => ({
    generateAgentToken: generateAgentTokenMock,
  }))

  // Stub recordAuditEvent so audit inserts don't perturb the db chain mock.
  const recordAuditEventMock = mock(async () => ({ id: 1 }))
  mock.module('../../../src/services/audit-log.js', () => ({
    recordAuditEvent: recordAuditEventMock,
  }))

  const {
    claimEnrollmentToken,
    createEnrollmentToken,
    listEnrollmentTokens,
    revokeEnrollmentToken,
    ConcurrentEnrollmentError,
  } = await import('../../../src/services/enrollment-tokens.js')

  const FIXED_DATE = new Date('2026-06-18T00:00:00.000Z')
  const tokenRow = (over: Record<string, unknown> = {}) => ({
    id: 1,
    projectId: 10,
    label: null,
    secretHash: 'EHASH-1',
    isReusable: false,
    maxUses: null,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdByUserId: 1,
    lastUsedAt: null,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    ...over,
  })

  beforeEach(() => {
    selectQueue = []
    insertReturningQueue = []
    updateReturningQueue = []
    capturedUpdateSets = []
    parseResult = { tokenId: 1, secret: 'brave-coral-otter-47' }
    verifyResult = true
    selectMock.mockClear()
    insertMock.mockClear()
    updateMock.mockClear()
    generateAgentTokenMock.mockClear()
    generateEnrollmentTokenMock.mockClear()
    recordAuditEventMock.mockClear()
    ;(dbMock['transaction'] as ReturnType<typeof mock>).mockClear()
  })

  // ─── createEnrollmentToken ──────────────────────────────────────────
  describe('createEnrollmentToken', () => {
    it('mints a token, persists only the hash, and returns metadata without the secret', async () => {
      insertReturningQueue = [[{ id: 5 }]]
      updateReturningQueue = [[tokenRow({ id: 5, label: 'rack-3 rigs', secretHash: 'EHASH-5' })]]

      const result = await createEnrollmentToken(10, 1, {
        label: 'rack-3 rigs',
        isReusable: true,
        maxUses: 3,
      })

      expect(result.token).toBe('etk_5_brave-coral-otter-47')
      expect(generateEnrollmentTokenMock).toHaveBeenCalledWith(5)
      expect(result.metadata.id).toBe(5)
      expect(result.metadata.label).toBe('rack-3 rigs')
      // Wire metadata must never carry the secret or its hash.
      expect(result.metadata).not.toHaveProperty('secretHash')
      expect(result.metadata).not.toHaveProperty('secret')
      // Timestamps cross the wire as ISO strings.
      expect(result.metadata.createdAt).toBe('2026-06-18T00:00:00.000Z')
    })
  })

  // ─── listEnrollmentTokens ───────────────────────────────────────────
  describe('listEnrollmentTokens', () => {
    it('returns metadata for the project, never the secret hash', async () => {
      selectQueue = [[tokenRow(), tokenRow({ id: 2, label: 'lab' })]]
      const rows = await listEnrollmentTokens(10)
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row).not.toHaveProperty('secretHash')
        expect(typeof row.createdAt).toBe('string')
      }
    })
  })

  // ─── revokeEnrollmentToken ──────────────────────────────────────────
  describe('revokeEnrollmentToken', () => {
    it('returns null when the token is not in the project', async () => {
      selectQueue = [[]]
      expect(await revokeEnrollmentToken(99, 10)).toBeNull()
    })

    it('revokes an active token and returns updated metadata', async () => {
      selectQueue = [[tokenRow()]]
      updateReturningQueue = [[tokenRow({ revokedAt: FIXED_DATE })]]
      const result = await revokeEnrollmentToken(1, 10)
      expect(result?.revokedAt).toBe('2026-06-18T00:00:00.000Z')
    })

    it('is idempotent for an already-revoked token (no second UPDATE)', async () => {
      selectQueue = [[tokenRow({ revokedAt: FIXED_DATE })]]
      const result = await revokeEnrollmentToken(1, 10)
      expect(result?.revokedAt).toBe('2026-06-18T00:00:00.000Z')
      expect(updateMock).not.toHaveBeenCalled()
    })
  })

  // ─── claimEnrollmentToken ───────────────────────────────────────────
  describe('claimEnrollmentToken', () => {
    it('rejects a malformed token without touching the DB', async () => {
      parseResult = null
      const result = await claimEnrollmentToken({ rawToken: 'garbage', clientId: 'c1' })
      expect(result).toEqual({ ok: false, reason: 'invalid' })
      expect(dbMock['transaction']).not.toHaveBeenCalled()
    })

    it('rejects an unknown token id', async () => {
      selectQueue = [[]] // token lookup misses
      const result = await claimEnrollmentToken({ rawToken: 'etk_99_x', clientId: 'c1' })
      expect(result).toEqual({ ok: false, reason: 'invalid' })
    })

    it('rejects a wrong secret (valid id)', async () => {
      verifyResult = false
      selectQueue = [[tokenRow()]]
      const result = await claimEnrollmentToken({ rawToken: 'etk_1_wrong', clientId: 'c1' })
      expect(result).toEqual({ ok: false, reason: 'invalid' })
    })

    it('happy path: consumes a use and issues a bearer for a new agent', async () => {
      selectQueue = [
        [tokenRow({ isReusable: true })], // token row
        [], // no existing agent for this clientId
      ]
      updateReturningQueue = [[{ id: 1 }]] // guarded consume succeeds
      // claimEnrollmentToken now does .returning() (full row) so the agent
      // insert must return a shape with at least id for issueAgentBearer.
      insertReturningQueue = [
        [
          {
            id: 42,
            projectId: 10,
            name: 'rig-a',
            status: 'offline',
            capabilities: {},
            hardwareProfile: {},
            enrollmentClientId: 'rig-a',
            enrolledByTokenId: 1,
            operatingSystemId: null,
            authToken: null,
            authTokenHash: null,
            authTokenFormat: 'plaintext',
            crackerVersion: null,
            lastSeenAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ]

      const result = await claimEnrollmentToken({
        rawToken: 'etk_1_brave-coral-otter-47',
        clientId: 'rig-a',
        name: 'rig-a',
      })

      expect(result).toEqual({ ok: true, agentId: 42, token: 'agt_42_rand' })
      expect(generateAgentTokenMock).toHaveBeenCalledWith(42)
    })

    it('idempotent retry: re-issues a bearer for an existing agent without inserting or consuming', async () => {
      selectQueue = [
        [tokenRow({ isReusable: true })], // select #1: token row (id: 1)
        [{ id: 7, enrolledByTokenId: 1 }], // select #2: existing agent — BOUND to this token
      ]
      updateReturningQueue = [[{ id: 1 }]] // guarded touch succeeds

      const result = await claimEnrollmentToken({
        rawToken: 'etk_1_brave-coral-otter-47',
        clientId: 'rig-a',
      })

      expect(result).toEqual({ ok: true, agentId: 7, token: 'agt_7_rand' })
      // No new agent row, and the guarded consume UPDATE never ran.
      expect(insertMock).not.toHaveBeenCalled()
    })

    it('rejects with "exhausted" when the guarded consume matches no row', async () => {
      selectQueue = [[tokenRow({ useCount: 1, isReusable: false })], []]
      updateReturningQueue = [[]] // guard matched nothing
      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-b' })
      expect(result).toEqual({ ok: false, reason: 'exhausted' })
    })

    it('rejects with "expired" when the token is past its expiry', async () => {
      const expiredRow = tokenRow({ expiresAt: new Date('2020-01-01T00:00:00Z') })
      selectQueue = [
        [expiredRow], // select #1: token row
        [], // select #2: no existing agent
        [expiredRow], // select #3: re-read in classifyClaimRejection — expiresAt in the past
      ]
      updateReturningQueue = [[]] // guarded consume returns []
      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-b' })
      expect(result).toEqual({ ok: false, reason: 'expired' })
    })

    it('rejects with "invalid" when the token is revoked', async () => {
      const revokedRow = tokenRow({ revokedAt: FIXED_DATE })
      selectQueue = [
        [revokedRow], // select #1: token row
        [], // select #2: no existing agent
        [revokedRow], // select #3: re-read in classifyClaimRejection — revokedAt set
      ]
      updateReturningQueue = [[]] // guarded consume returns []
      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-b' })
      expect(result).toEqual({ ok: false, reason: 'invalid' })
    })

    it('aborts (throws ConcurrentEnrollmentError) on a same-clientId insert conflict so the use rolls back', async () => {
      selectQueue = [[tokenRow({ isReusable: true })], []]
      updateReturningQueue = [[{ id: 1 }]] // consume succeeded
      insertReturningQueue = [[]] // ON CONFLICT DO NOTHING -> no row
      await expect(
        claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-a' })
      ).rejects.toBeInstanceOf(ConcurrentEnrollmentError)
    })

    // ─── C1 regression tests: bound-agent rejection paths ──────────────

    it('C1: revoked token + bound existing agent → guarded touch fails → invalid, no bearer issued', async () => {
      const revokedRow = tokenRow({ revokedAt: FIXED_DATE })
      selectQueue = [
        [revokedRow], // select #1: token row
        [{ id: 9, enrolledByTokenId: 1 }], // select #2: existing agent — BOUND to this token
        [revokedRow], // select #3: re-read in classifyClaimRejection — revokedAt set
      ]
      updateReturningQueue = [[]] // guarded touch returns [] (revoked)

      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-c' })
      expect(result).toEqual({ ok: false, reason: 'invalid' })
      // No bearer token should have been issued.
      expect(generateAgentTokenMock).not.toHaveBeenCalled()
    })

    it('C1: expired token + bound existing agent → guarded touch fails → expired, no bearer issued', async () => {
      const expiredRow = tokenRow({ expiresAt: new Date('2020-01-01T00:00:00Z') })
      selectQueue = [
        [expiredRow], // select #1: token row
        [{ id: 9, enrolledByTokenId: 1 }], // select #2: existing agent — BOUND to this token
        [expiredRow], // select #3: re-read in classifyClaimRejection — expiresAt in the past
      ]
      updateReturningQueue = [[]] // guarded touch returns [] (expired)

      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-c' })
      expect(result).toEqual({ ok: false, reason: 'expired' })
      // No bearer token should have been issued.
      expect(generateAgentTokenMock).not.toHaveBeenCalled()
    })

    it('binding mismatch: existing agent enrolled by a different token → invalid, no touch update consumed', async () => {
      selectQueue = [
        [tokenRow()], // select #1: token row (id: 1)
        [{ id: 9, enrolledByTokenId: 99 }], // select #2: existing agent — enrolled by token 99, not 1
      ]

      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-c' })
      expect(result).toEqual({ ok: false, reason: 'invalid' })
      // No touch update was consumed — short-circuited before the guarded update.
      expect(updateMock).not.toHaveBeenCalled()
    })

    it('cap-reached reusable token (no existing agent) → exhausted', async () => {
      const capRow = tokenRow({ isReusable: true, maxUses: 3, useCount: 3 })
      selectQueue = [
        [capRow], // select #1: token row
        [], // select #2: no existing agent
        [capRow], // select #3: re-read in classifyClaimRejection — still cap-reached (no revokedAt, expiresAt ok)
      ]
      updateReturningQueue = [[]] // guarded consume returns [] (cap reached)

      const result = await claimEnrollmentToken({ rawToken: 'etk_1_x', clientId: 'rig-d' })
      expect(result).toEqual({ ok: false, reason: 'exhausted' })
    })
  })
}
