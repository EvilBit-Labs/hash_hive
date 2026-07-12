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

import { type UserRole, baAccounts, ldapLinkRequests, users } from '@hashhive/shared'
import { desc, eq, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
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

/** Narrow, unvalidated shape shared by both a raw driver error and DrizzleQueryError. */
interface MaybeCodedError {
  code?: unknown
  cause?: unknown
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). Mirrors
 * `services/ldap-provisioning.ts`'s helper of the same name -- see that
 * module for why the `.cause` chain walk is necessary (`db.transaction` /
 * `tx.insert(...)` wrap the raw driver error in a `DrizzleQueryError`).
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 3 && current !== null && typeof current === 'object'; depth++) {
    const candidate = current as MaybeCodedError
    if (candidate.code === '23505') {
      return true
    }
    current = candidate.cause
  }
  return false
}

// ─── Wire-shaped row types ────────────────────────────────────────────────

type LdapLinkRequestRow = typeof ldapLinkRequests.$inferSelect

/** A pending or resolved `ldap_link_requests` row, dates rendered as ISO strings. */
export interface LdapLinkRequestView {
  id: number
  username: string
  derivedEmail: string
  resolvedRole: UserRole
  matchedUserId: number
  status: 'pending' | 'linked' | 'rejected'
  createdAt: string
  updatedAt: string
}

function toView(row: LdapLinkRequestRow): LdapLinkRequestView {
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

export interface ListPendingLinkRequestsResult {
  data: LdapLinkRequestView[]
  total: number
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
): Promise<ListPendingLinkRequestsResult> {
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

async function closeRequest(
  tx: Tx,
  requestId: number,
  status: 'linked' | 'rejected'
): Promise<LdapLinkRequestRow> {
  const [updated] = await tx
    .update(ldapLinkRequests)
    .set({ status, updatedAt: new Date() })
    .where(eq(ldapLinkRequests.id, requestId))
    .returning()

  if (!updated) {
    throw new Error(`ldap-reconciliation: failed to close link request ${requestId}`)
  }
  return updated
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
): Promise<LdapLinkRequestView> {
  return db.transaction(async (tx) => {
    const existing = await loadPendingRequest(tx, input.requestId)

    if (input.action === 'reject') {
      return resolveReject(tx, existing, actor)
    }

    return resolveLink(tx, existing, input.targetUserId, actor)
  })
}
