/**
 * Admin reconciliation surface for AD/LDAP directory-login collisions (U7,
 * R12). U4's `resolveDirectoryUser` writes a `pending` `ldap_link_requests`
 * row whenever a directory login's derived email collides with an existing
 * HashHive account that already has a local password (R11) -- the login is
 * denied and the account is never mutated automatically.
 *
 * This module lets a HashHive admin resolve one of those pending rows:
 *
 *   - `listPendingLinkRequests` -- the open (`status: 'pending'`) queue.
 *   - `resolveLinkRequest` -- either:
 *       - `action: 'link'` -- attach a new `ldap` `ba_accounts` row
 *         (`accountId: <directory username>`) to the admin's chosen local
 *         account (`targetUserId`) and close the request (`status:
 *         'linked'`). The `targetUserId` need not be the request's
 *         `matchedUserId` -- the admin may link the directory identity to a
 *         different local account entirely.
 *       - `action: 'reject'` -- close the request (`status: 'rejected'`)
 *         without linking anything.
 *
 * Deliberately does NOT touch `users.roles`. The pending row's
 * `resolvedRole` is historical context for the admin's decision (the role
 * the directory groups would have granted at collision time) -- linking
 * does not silently re-apply it. Role changes for a newly-linked directory
 * identity happen the normal way, through that user's *next* directory
 * login (`resolveDirectoryUser`'s re-sync branch, routed through
 * `assertLocalAdminRemains`), not through this admin action. This keeps
 * U7 a pure identity-linking decision and avoids entangling it with the
 * break-glass floor guard.
 *
 * Resolving an already-closed request (`status` is `linked` or `rejected`)
 * is a typed, idempotent-safe rejection (`LdapLinkRequestAlreadyResolvedError`)
 * -- never a raw 500 and never a silent no-op. A `link` whose directory
 * username is already linked to some account, or whose target user already
 * has an `ldap` account, is caught via the same `ba_accounts` unique
 * indexes U4 relies on (`(provider_id, account_id)` and `(user_id,
 * provider_id)`) and surfaced as `LdapLinkTargetAlreadyLinkedError`, not a
 * raw 500.
 *
 * Every resolution is audit-logged (`ldap.link_approved` /
 * `ldap.link_rejected`) with the resolving admin as actor. Never logs
 * credentials -- nothing on this path ever touches a password.
 */

import type { LdapLinkRequest, LdapLinkRequestListResponse } from '@hashhive/shared'

import { baAccounts, ldapLinkRequests, users } from '@hashhive/shared'
import { and, desc, eq, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { isUniqueViolation } from '../db/unique-violation.js'
import { type AuditActor, recordAuditEvent } from './audit-log.js'

/** Drizzle transaction handle — mirrors ldap-provisioning.ts's `Tx` alias. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ─── Typed domain errors ─────────────────────────────────────────────────

/** No `ldap_link_requests` row exists with the given id. Maps to 404. */
export class LdapLinkRequestNotFoundError extends Error {
  constructor(public readonly requestId: number) {
    super(`ldap_link_requests row ${requestId} not found`)
    this.name = 'LdapLinkRequestNotFoundError'
  }
}

/** The request was already resolved (linked or rejected). Maps to 409. */
export class LdapLinkRequestAlreadyResolvedError extends Error {
  constructor(
    public readonly requestId: number,
    public readonly status: string
  ) {
    super(`ldap_link_requests row ${requestId} is already resolved (status: ${status})`)
    this.name = 'LdapLinkRequestAlreadyResolvedError'
  }
}

/** `action: 'link'` named a `targetUserId` that does not exist. Maps to 404. */
export class LdapLinkTargetNotFoundError extends Error {
  constructor(public readonly targetUserId: number) {
    super(`target user ${targetUserId} not found`)
    this.name = 'LdapLinkTargetNotFoundError'
  }
}

/**
 * `action: 'link'` would violate a `ba_accounts` unique index -- either the
 * directory username is already linked to a (different) account, or
 * `targetUserId` already has an `ldap` account linked. Maps to 409.
 */
export class LdapLinkTargetAlreadyLinkedError extends Error {
  constructor(
    public readonly targetUserId: number,
    public readonly username: string
  ) {
    super(
      `cannot link directory username '${username}' to user ${targetUserId}: an ldap account link already exists`
    )
    this.name = 'LdapLinkTargetAlreadyLinkedError'
  }
}

// ─── Wire-shaped row types ────────────────────────────────────────────────
//
// `LdapLinkRequest` / `LdapLinkRequestListResponse` are the shared
// `z.infer` wire types (`packages/shared/src/schemas/index.ts`), not
// locally-declared lookalikes -- keeps this service's return shapes and the
// `ldapLinkRequestSchema` / `ldapLinkRequestListResponseSchema` OpenAPI
// contract (`routes/dashboard/ldap-link-requests.ts`) from drifting apart.

type LdapLinkRequestRow = typeof ldapLinkRequests.$inferSelect

/** The single DB-row -> shared-wire-type mapper. */
function toView(row: LdapLinkRequestRow): LdapLinkRequest {
  return {
    id: row.id,
    username: row.username,
    derivedEmail: row.derivedEmail,
    // No cast needed: the `.$type<>()` branding on ldapLinkRequests.resolvedRole
    // / .status (packages/shared/src/db/schema.ts) already narrows these to the
    // UserRole / status union, backed by the ldap_link_requests_resolved_role_chk
    // / ldap_link_requests_status_chk CHECK constraints.
    resolvedRole: row.resolvedRole,
    matchedUserId: row.matchedUserId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// ─── List (R12) ────────────────────────────────────────────────────────────

export interface ListPendingLinkRequestsPagination {
  limit: number
  offset: number
}

/**
 * Returns a paginated page of OPEN (`status: 'pending'`) reconciliation
 * requests, newest first. Resolved rows (linked/rejected) never appear --
 * they are a permanent audit trail, not a queue to page through.
 */
export async function listPendingLinkRequests(
  pagination: ListPendingLinkRequestsPagination
): Promise<LdapLinkRequestListResponse> {
  const { limit, offset } = pagination
  const whereClause = eq(ldapLinkRequests.status, 'pending')

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(ldapLinkRequests)
      .where(whereClause)
      .orderBy(desc(ldapLinkRequests.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(ldapLinkRequests)
      .where(whereClause),
  ])

  const total = Number(countResult[0]?.count ?? 0)
  return { data: rows.map(toView), total, limit, offset }
}

// ─── Resolve (R12) ───────────────────────────────────────────────────────

export type ResolveLinkRequestInput =
  | { requestId: number; action: 'reject' }
  | { requestId: number; action: 'link'; targetUserId: number }

async function loadPendingRequest(tx: Tx, requestId: number): Promise<LdapLinkRequestRow> {
  const [existing] = await tx
    .select()
    .from(ldapLinkRequests)
    .where(eq(ldapLinkRequests.id, requestId))
    .limit(1)

  if (!existing) {
    throw new LdapLinkRequestNotFoundError(requestId)
  }
  if (existing.status !== 'pending') {
    throw new LdapLinkRequestAlreadyResolvedError(requestId, existing.status)
  }
  return existing
}

/**
 * Closes `requestId` ONLY if it is still `pending` (FIX 3 / P2 code
 * review) -- the `WHERE status = 'pending'` guard makes this a
 * compare-and-swap against Postgres's row lock: if a concurrent
 * resolution already closed the row between `loadPendingRequest`'s
 * (unlocked) SELECT and this UPDATE, the UPDATE matches zero rows instead
 * of silently overwriting the winner's `status` (previously possible --
 * e.g. a losing `reject` overwriting an already-committed `link`, even
 * though that link's `ba_accounts` row was already created). A zero-row
 * result is re-read and surfaced as the same typed
 * `LdapLinkRequestAlreadyResolvedError` `loadPendingRequest` throws for
 * the non-racing case -- never a raw 500, never a silent no-op.
 */
async function closeRequest(
  tx: Tx,
  requestId: number,
  status: 'linked' | 'rejected'
): Promise<LdapLinkRequestRow> {
  const [updated] = await tx
    .update(ldapLinkRequests)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(ldapLinkRequests.id, requestId), eq(ldapLinkRequests.status, 'pending')))
    .returning()

  if (updated) {
    return updated
  }

  const [current] = await tx
    .select({ status: ldapLinkRequests.status })
    .from(ldapLinkRequests)
    .where(eq(ldapLinkRequests.id, requestId))
    .limit(1)

  if (!current) {
    throw new LdapLinkRequestNotFoundError(requestId)
  }
  throw new LdapLinkRequestAlreadyResolvedError(requestId, current.status)
}

async function resolveReject(tx: Tx, existing: LdapLinkRequestRow, actor: AuditActor) {
  const updated = await closeRequest(tx, existing.id, 'rejected')

  await recordAuditEvent(
    {
      actor,
      projectId: null,
      entityType: 'user',
      entityId: existing.matchedUserId,
      action: 'ldap.link_rejected',
      reason: 'admin rejected ldap link request',
    },
    tx
  )

  return toView(updated)
}

async function resolveLink(
  tx: Tx,
  existing: LdapLinkRequestRow,
  targetUserId: number,
  actor: AuditActor
) {
  const [targetUser] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1)

  if (!targetUser) {
    throw new LdapLinkTargetNotFoundError(targetUserId)
  }

  try {
    await tx.insert(baAccounts).values({
      id: crypto.randomUUID(),
      userId: targetUserId,
      accountId: existing.username,
      providerId: 'ldap',
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new LdapLinkTargetAlreadyLinkedError(targetUserId, existing.username)
    }
    throw err
  }

  const updated = await closeRequest(tx, existing.id, 'linked')

  await recordAuditEvent(
    {
      actor,
      projectId: null,
      entityType: 'user',
      entityId: targetUserId,
      action: 'ldap.link_approved',
      reason: 'admin linked ldap directory account',
    },
    tx
  )

  return toView(updated)
}

/**
 * Resolve one pending `ldap_link_requests` row by linking it to a chosen
 * local account (`action: 'link'`) or rejecting it (`action: 'reject'`).
 * `actor` is the resolving admin, recorded on the audit row -- resolved
 * from the request's auth context by the route handler, never trusted from
 * the request body.
 *
 * Every branch runs inside one transaction so the `ba_accounts` insert (for
 * `link`) and the request's status close are atomic.
 */
export async function resolveLinkRequest(
  input: ResolveLinkRequestInput,
  actor: AuditActor
): Promise<LdapLinkRequest> {
  return db.transaction(async (tx) => {
    const existing = await loadPendingRequest(tx, input.requestId)

    if (input.action === 'reject') {
      return resolveReject(tx, existing, actor)
    }

    return resolveLink(tx, existing, input.targetUserId, actor)
  })
}
