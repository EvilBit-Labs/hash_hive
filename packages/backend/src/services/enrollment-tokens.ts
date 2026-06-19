/**
 * Enrollment-token service — mint / list / revoke (dashboard, admin) and
 * the security-critical `claimEnrollmentToken` path (agent enrollment).
 *
 * Minting inserts the row first to obtain the id (the token's routing
 * hint), then stores the bcrypt hash of the generated secret. The raw
 * token is returned to the caller exactly once and never persisted.
 *
 * Claiming is the heart of the feature: it atomically validates and
 * consumes the enrollment token and issues the new agent its long-lived
 * bearer token, all in one transaction so a failure can never leave a
 * half-enrolled agent or a phantom-consumed use.
 */
import type { EnrollAgentRequest, EnrollmentTokenMetadata } from '@hashhive/shared'

import { agents, enrollmentTokens } from '@hashhive/shared'
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { generateAgentToken } from '../lib/agent-token.js'
import {
  generateEnrollmentToken,
  parseEnrollmentToken,
  verifyEnrollmentTokenHash,
} from '../lib/enrollment-token.js'

// Row shape returned by selecting from enrollment_tokens (Dates, not ISO).
type EnrollmentTokenRow = typeof enrollmentTokens.$inferSelect

// The transaction handle passed to db.transaction's callback.
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// The non-secret columns `toMetadata` maps. Narrowed so a caller cannot
// pass a row that still carries `secretHash` into a wire-bound mapper, and
// so the list path can select exactly these columns (never `secretHash`).
const metadataColumns = {
  id: enrollmentTokens.id,
  projectId: enrollmentTokens.projectId,
  label: enrollmentTokens.label,
  isReusable: enrollmentTokens.isReusable,
  maxUses: enrollmentTokens.maxUses,
  useCount: enrollmentTokens.useCount,
  expiresAt: enrollmentTokens.expiresAt,
  revokedAt: enrollmentTokens.revokedAt,
  lastUsedAt: enrollmentTokens.lastUsedAt,
  createdAt: enrollmentTokens.createdAt,
} as const

type EnrollmentTokenMetadataRow = Pick<EnrollmentTokenRow, keyof typeof metadataColumns>

/** Map a DB row to the wire metadata shape (Dates -> ISO strings, no secret). */
function toMetadata(row: EnrollmentTokenMetadataRow): EnrollmentTokenMetadata {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    isReusable: row.isReusable,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

export interface CreateEnrollmentTokenInput {
  label?: string | undefined
  isReusable: boolean
  maxUses?: number | undefined
  /** Absolute UTC expiry. Caller (route) has already validated it is in the future. */
  expiresAt?: Date | undefined
}

/**
 * Mint a new enrollment token for a project. Returns the raw token (shown
 * once) and the durable metadata. Insert-then-hash so the row id can be
 * embedded as the token's routing hint, mirroring how `rotateAgentToken`
 * needs the agent row to exist before `generateAgentToken(agentId)`.
 */
export async function createEnrollmentToken(
  projectId: number,
  createdByUserId: number,
  input: CreateEnrollmentTokenInput
): Promise<{ token: string; metadata: EnrollmentTokenMetadata }> {
  return db.transaction(async (tx) => {
    // Placeholder secret_hash satisfies NOT NULL; never visible outside
    // this transaction, and overwritten below before commit.
    const [inserted] = await tx
      .insert(enrollmentTokens)
      .values({
        projectId,
        createdByUserId,
        label: input.label ?? null,
        secretHash: '',
        isReusable: input.isReusable,
        maxUses: input.maxUses ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({ id: enrollmentTokens.id })

    if (!inserted) {
      throw new Error('Failed to insert enrollment token row')
    }

    const { token, hash } = await generateEnrollmentToken(inserted.id)
    const [row] = await tx
      .update(enrollmentTokens)
      .set({ secretHash: hash, updatedAt: new Date() })
      .where(eq(enrollmentTokens.id, inserted.id))
      .returning()

    if (!row) {
      throw new Error('Failed to finalize enrollment token row')
    }

    return { token, metadata: toMetadata(row) }
  })
}

/**
 * List a project's enrollment tokens (newest first), metadata only — the
 * secret hash is never selected onto the wire. Revoked tokens are included
 * so operators see the full history.
 */
export async function listEnrollmentTokens(projectId: number): Promise<EnrollmentTokenMetadata[]> {
  const rows = await db
    .select(metadataColumns)
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.projectId, projectId))
    .orderBy(sql`${enrollmentTokens.createdAt} DESC`)
  return rows.map(toMetadata)
}

/**
 * Revoke an enrollment token (project-scoped). Idempotent: revoking an
 * already-revoked token returns its (unchanged) metadata. Returns null
 * when the token does not exist in this project — the route maps that to
 * 404.
 */
export async function revokeEnrollmentToken(
  id: number,
  projectId: number
): Promise<EnrollmentTokenMetadata | null> {
  const [existing] = await db
    .select()
    .from(enrollmentTokens)
    .where(and(eq(enrollmentTokens.id, id), eq(enrollmentTokens.projectId, projectId)))
  if (!existing) return null
  if (existing.revokedAt) return toMetadata(existing)

  const now = new Date()
  const [updated] = await db
    .update(enrollmentTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(enrollmentTokens.id, id), eq(enrollmentTokens.projectId, projectId)))
    .returning()
  return updated ? toMetadata(updated) : null
}

/** Why an enrollment claim was rejected. Kept opaque to the agent. */
export type EnrollmentRejectionReason = 'invalid' | 'expired' | 'exhausted'

export type ClaimEnrollmentResult =
  | { ok: true; agentId: number; token: string }
  | { ok: false; reason: EnrollmentRejectionReason }

/**
 * Thrown when a concurrent claim with the same (project, clientId) won the
 * insert race. The losing transaction rolls back (so its consumed use is
 * released); the agent should simply retry, landing on the idempotent path.
 * The route maps this to a retryable 409 rather than an opaque 500.
 */
export class ConcurrentEnrollmentError extends Error {
  constructor() {
    super('Concurrent enrollment for the same clientId — retry')
    this.name = 'ConcurrentEnrollmentError'
  }
}

// The wire request carries `token`; the service works with the already-
// extracted `rawToken`. Otherwise identical to the shared wire shape — no
// local re-declaration of cross-boundary fields (see AGENTS.md).
export type ClaimEnrollmentInput = Omit<EnrollAgentRequest, 'token'> & {
  /** The raw `etk_<id>_<phrase>` token string presented by the agent. */
  rawToken: string
}

/**
 * Validate + consume an enrollment token and issue a new agent's bearer
 * token. The whole thing runs in one transaction:
 *
 * 1. Parse + bcrypt-verify the secret (unknown id / bad secret -> invalid).
 * 2. Idempotent retry: if an agent already exists for (project, clientId),
 *    re-issue its bearer WITHOUT consuming a use (handles a dropped 201) —
 *    but only when the SAME token enrolled it (binding) and the token is
 *    still active (a guarded touch gates revoked/expired before re-issue).
 * 3. Atomic guarded consume: a single UPDATE increments use_count only
 *    when the token is active, unexpired, and not exhausted. Concurrency-
 *    safe — under READ COMMITTED a second claim re-evaluates the guard
 *    against the committed row, so a one-time / max_uses token can never
 *    over-issue.
 * 4. Create the agent and mint its bearer token (`agt_<id>_<random>`).
 *
 * Returns the raw bearer token exactly once; only its hash is persisted.
 */
export async function claimEnrollmentToken(
  input: ClaimEnrollmentInput
): Promise<ClaimEnrollmentResult> {
  const parsed = parseEnrollmentToken(input.rawToken)
  if (!parsed) return { ok: false, reason: 'invalid' }

  return db.transaction(async (tx) => {
    const [tokenRow] = await tx
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.id, parsed.tokenId))
    if (!tokenRow) return { ok: false, reason: 'invalid' } as const

    const secretOk = await verifyEnrollmentTokenHash(parsed.secret, tokenRow.secretHash)
    if (!secretOk) return { ok: false, reason: 'invalid' } as const

    const now = new Date()

    // (2) Idempotent retry: same (project, clientId) already enrolled.
    // Re-issue a bearer for that row WITHOUT consuming a use — but only if
    // the same token enrolled it (binding) and the token is still valid.
    const [existingAgent] = await tx
      .select({ id: agents.id, enrolledByTokenId: agents.enrolledByTokenId })
      .from(agents)
      .where(
        and(eq(agents.projectId, tokenRow.projectId), eq(agents.enrollmentClientId, input.clientId))
      )
    if (existingAgent) {
      // A foreign token (or a legacy NULL binding) must not re-credential an
      // agent it did not enroll — otherwise any valid project token could
      // rotate/hijack another agent's bearer. Collapse to opaque 'invalid'.
      if (existingAgent.enrolledByTokenId !== tokenRow.id) {
        return { ok: false, reason: 'invalid' } as const
      }
      // The guarded touch doubles as the revoked/expired gate: 0 rows => the
      // token was revoked or expired (possibly concurrently). Reject BEFORE
      // issuing a bearer so a revoked token can never re-issue credentials.
      const [touched] = await tx
        .update(enrollmentTokens)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(
          and(
            eq(enrollmentTokens.id, tokenRow.id),
            isNull(enrollmentTokens.revokedAt),
            or(isNull(enrollmentTokens.expiresAt), gt(enrollmentTokens.expiresAt, now))
          )
        )
        .returning({ id: enrollmentTokens.id })
      if (!touched) return classifyClaimRejection(tx, tokenRow.id, now)

      const token = await issueAgentBearer(tx, existingAgent.id)
      return { ok: true, agentId: existingAgent.id, token } as const
    }

    // (3) Atomic guarded consume. Zero rows => not consumable right now.
    const consumed = await tx
      .update(enrollmentTokens)
      .set({ useCount: sql`${enrollmentTokens.useCount} + 1`, lastUsedAt: now, updatedAt: now })
      .where(
        and(
          eq(enrollmentTokens.id, tokenRow.id),
          isNull(enrollmentTokens.revokedAt),
          or(isNull(enrollmentTokens.expiresAt), gt(enrollmentTokens.expiresAt, now)),
          or(eq(enrollmentTokens.isReusable, true), eq(enrollmentTokens.useCount, 0)),
          or(
            isNull(enrollmentTokens.maxUses),
            sql`${enrollmentTokens.useCount} < ${enrollmentTokens.maxUses}`
          )
        )
      )
      .returning({ id: enrollmentTokens.id })

    if (consumed.length === 0) {
      // Re-read the committed row to classify accurately even when a
      // concurrent revoke/expiry raced our snapshot (which might still show
      // the token as active).
      return classifyClaimRejection(tx, tokenRow.id, now)
    }

    // (4) Create the agent, then mint its bearer. ON CONFLICT guards the
    // rare concurrent same-clientId race: if another claim inserted the
    // row first, abort so the consumed use is rolled back with the
    // transaction (the agent should retry and hit the idempotent path).
    const [agent] = await tx
      .insert(agents)
      .values({
        name: input.name ?? input.clientId,
        projectId: tokenRow.projectId,
        enrollmentClientId: input.clientId,
        enrolledByTokenId: tokenRow.id,
        status: 'offline',
        capabilities: input.capabilities ?? {},
        hardwareProfile: input.hardwareProfile ?? {},
      })
      .onConflictDoNothing({ target: [agents.projectId, agents.enrollmentClientId] })
      .returning({ id: agents.id })

    if (!agent) {
      throw new ConcurrentEnrollmentError()
    }

    const token = await issueAgentBearer(tx, agent.id)
    return { ok: true, agentId: agent.id, token } as const
  })
}

/**
 * Classify why a guarded consume/touch matched zero rows by re-reading the
 * committed token row, so a concurrent revoke/expiry is reflected rather
 * than the caller's stale snapshot. Order matters: revoked and expired are
 * explicit; anything else means the usage cap was reached.
 */
async function classifyClaimRejection(
  tx: DbTx,
  tokenId: number,
  now: Date
): Promise<{ ok: false; reason: EnrollmentRejectionReason }> {
  const [live] = await tx
    .select({ revokedAt: enrollmentTokens.revokedAt, expiresAt: enrollmentTokens.expiresAt })
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.id, tokenId))
  if (live?.revokedAt) return { ok: false, reason: 'invalid' }
  if (live?.expiresAt && live.expiresAt <= now) return { ok: false, reason: 'expired' }
  return { ok: false, reason: 'exhausted' }
}

/**
 * Mint a fresh bearer token for an agent row and persist its bcrypt hash.
 * Mirrors `rotateAgentToken` but participates in the caller's transaction.
 * Returns the raw token for the handler to return exactly once.
 */
async function issueAgentBearer(tx: DbTx, agentId: number): Promise<string> {
  const { token, hash } = await generateAgentToken(agentId)
  await tx
    .update(agents)
    .set({ authToken: null, authTokenHash: hash, authTokenFormat: 'bcrypt', updatedAt: new Date() })
    .where(eq(agents.id, agentId))
  return token
}
