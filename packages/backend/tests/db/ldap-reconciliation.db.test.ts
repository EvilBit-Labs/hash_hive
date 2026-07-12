/**
 * Real-DB tests for the AD/LDAP admin reconciliation surface (U7, R12):
 * `listPendingLinkRequests` / `resolveLinkRequest` in
 * `services/ldap-reconciliation.ts`.
 *
 * Proves SQL-level behavior the mocked default lane cannot: the
 * `ldap_link_requests_status_chk` CHECK, the `ba_accounts (provider_id,
 * account_id)` and `(user_id, provider_id)` unique indexes actually
 * rejecting a duplicate `link`, and the transactional interplay between
 * closing the request and inserting the `ba_accounts` row.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts) against the
 * isolated `hashhive_test` database. Every describe block seeds its own
 * rows; `cleanupSeed` removes them by email domain so runs are idempotent
 * and order-independent.
 *
 * NOTE: do NOT call `client.end()` here -- `harness.test.ts` owns the
 * shared drizzle client lifecycle. NOTE: do NOT self-skip -- the test-db
 * lane always has Postgres available.
 */

import { auditLogs, baAccounts, ldapLinkRequests, users } from '@hashhive/shared'
import { afterAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray, like } from 'drizzle-orm'

import type { AuditActor } from '../../src/services/audit-log.js'

import { db } from '../../src/db/index.js'
import {
  LdapLinkRequestAlreadyResolvedError,
  LdapLinkTargetAlreadyLinkedError,
  LdapLinkTargetNotFoundError,
  listPendingLinkRequests,
  resolveLinkRequest,
} from '../../src/services/ldap-reconciliation.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const EMAIL_DOMAIN = 'ldap-reconciliation-db-test.hashhive.local'
const RESOLVING_ADMIN: AuditActor = { actorType: 'user', actorId: 999_999 }

// ─── Seed helpers ───────────────────────────────────────────────────────────

/** Insert a local (non-directory) user row. Returns the new user's id. */
async function seedLocalUser(label: string, roles: string[] = ['analyst']): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${label}@${EMAIL_DOMAIN}`,
      passwordHash: null,
      name: `LDAP Reconciliation Test - ${label}`,
      roles,
    })
    .returning({ id: users.id })
  return user!.id
}

/** Insert a pending `ldap_link_requests` row. Returns the new row's id. */
async function seedPendingRequest(
  username: string,
  matchedUserId: number,
  overrides: { status?: 'pending' | 'linked' | 'rejected' } = {}
): Promise<number> {
  const [row] = await db
    .insert(ldapLinkRequests)
    .values({
      username,
      derivedEmail: `${username}@${EMAIL_DOMAIN}`,
      resolvedRole: 'operator',
      matchedUserId,
      status: overrides.status ?? 'pending',
    })
    .returning({ id: ldapLinkRequests.id })
  return row!.id
}

/** Remove all seed rows for this test run. Cascades handle ba_accounts. */
async function cleanupSeed(): Promise<void> {
  const seededUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, `%@${EMAIL_DOMAIN}`))
  const ids = seededUsers.map((u) => u.id)

  // audit_logs.entity_id has no FK (polymorphic) so it does not cascade
  // when the user row is deleted -- clean it up explicitly.
  if (ids.length > 0) {
    await db
      .delete(auditLogs)
      .where(and(eq(auditLogs.entityType, 'user'), inArray(auditLogs.entityId, ids)))
  }
  // ldap_link_requests.matched_user_id cascades on user delete, but rows
  // seeded against a since-deleted user from a prior failed run wouldn't
  // still exist -- deleting users is sufficient cleanup.
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`))
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  await cleanupSeed()
})

describe('listPendingLinkRequests', () => {
  it('returns only open (pending) requests, not linked or rejected ones', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('list-target')
    const pendingId = await seedPendingRequest('list-pending-user', matchedUserId)
    const linkedId = await seedPendingRequest('list-linked-user', matchedUserId, {
      status: 'linked',
    })
    const rejectedId = await seedPendingRequest('list-rejected-user', matchedUserId, {
      status: 'rejected',
    })

    const result = await listPendingLinkRequests({ limit: 50, offset: 0 })
    const ids = result.data.map((row) => row.id)

    expect(ids).toContain(pendingId)
    expect(ids).not.toContain(linkedId)
    expect(ids).not.toContain(rejectedId)

    const pendingRow = result.data.find((row) => row.id === pendingId)
    expect(pendingRow?.status).toBe('pending')
    expect(pendingRow?.username).toBe('list-pending-user')
    expect(pendingRow?.resolvedRole).toBe('operator')
    expect(typeof pendingRow?.createdAt).toBe('string')

    await cleanupSeed()
  })

  it('respects limit/offset pagination and reports total', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('paging-target')
    await seedPendingRequest('paging-user-1', matchedUserId)
    await seedPendingRequest('paging-user-2', matchedUserId)
    await seedPendingRequest('paging-user-3', matchedUserId)

    const page = await listPendingLinkRequests({ limit: 2, offset: 0 })
    expect(page.data).toHaveLength(2)
    expect(page.total).toBeGreaterThanOrEqual(3)
    expect(page.limit).toBe(2)
    expect(page.offset).toBe(0)

    await cleanupSeed()
  })
})

describe('resolveLinkRequest — link (R12)', () => {
  it('creates the ldap ba_accounts link and closes the request as linked', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('link-collision-target')
    const targetUserId = await seedLocalUser('link-chosen-target')
    const requestId = await seedPendingRequest('link-directory-username', matchedUserId)

    const result = await resolveLinkRequest(
      { requestId, action: 'link', targetUserId },
      RESOLVING_ADMIN
    )

    expect(result.status).toBe('linked')
    expect(result.id).toBe(requestId)

    const [account] = await db
      .select()
      .from(baAccounts)
      .where(
        and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, 'link-directory-username'))
      )
    expect(account).toBeDefined()
    expect(account!.userId).toBe(targetUserId)
    expect(account!.password).toBeNull()

    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe('linked')

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'user'),
          eq(auditLogs.entityId, targetUserId),
          eq(auditLogs.action, 'ldap.link_approved')
        )
      )
    expect(audit).toBeDefined()
    expect(audit!.actorType).toBe('user')
    expect(audit!.actorId).toBe(RESOLVING_ADMIN.actorId)
    expect(JSON.stringify(audit)).not.toContain('password')

    await cleanupSeed()
  })

  it('rejects linking to a nonexistent target user with a typed error', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('link-notfound-target')
    const requestId = await seedPendingRequest('link-notfound-username', matchedUserId)
    const bogusTargetUserId = 999_999_999

    await expect(
      resolveLinkRequest(
        { requestId, action: 'link', targetUserId: bogusTargetUserId },
        RESOLVING_ADMIN
      )
    ).rejects.toThrow(LdapLinkTargetNotFoundError)

    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe('pending') // unchanged -- rolled back atomically

    await cleanupSeed()
  })

  it('rejects linking when the directory username is already linked to another account (unique index)', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('link-dup-collision-target')
    const alreadyLinkedUserId = await seedLocalUser('link-dup-already-linked')
    const otherTargetUserId = await seedLocalUser('link-dup-other-target')
    const username = 'link-dup-directory-username'

    // Simulate: this directory username is already linked elsewhere (e.g. a
    // prior first login via U4's JIT path, or a previously-resolved request).
    await db.insert(baAccounts).values({
      id: crypto.randomUUID(),
      userId: alreadyLinkedUserId,
      accountId: username,
      providerId: 'ldap',
    })

    const requestId = await seedPendingRequest(username, matchedUserId)

    await expect(
      resolveLinkRequest(
        { requestId, action: 'link', targetUserId: otherTargetUserId },
        RESOLVING_ADMIN
      )
    ).rejects.toThrow(LdapLinkTargetAlreadyLinkedError)

    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe('pending') // unchanged

    const accounts = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, username)))
    expect(accounts).toHaveLength(1) // no second row was created

    await cleanupSeed()
  })

  it('rejects linking when the target user already has an ldap account (unique index)', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('link-dup-target-collision-target')
    const targetUserId = await seedLocalUser('link-dup-target-already-linked')

    // The chosen target already has a DIFFERENT directory identity linked
    // -- distinct trigger from the (provider_id, account_id) case above:
    // this hits ba_accounts_user_id_provider_id_idx (userId, providerId).
    await db.insert(baAccounts).values({
      id: crypto.randomUUID(),
      userId: targetUserId,
      accountId: 'link-dup-target-some-other-directory-username',
      providerId: 'ldap',
    })

    const username = 'link-dup-target-directory-username'
    const requestId = await seedPendingRequest(username, matchedUserId)

    await expect(
      resolveLinkRequest({ requestId, action: 'link', targetUserId }, RESOLVING_ADMIN)
    ).rejects.toThrow(LdapLinkTargetAlreadyLinkedError)

    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe('pending') // unchanged

    const accounts = await db
      .select()
      .from(baAccounts)
      .where(and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, username)))
    expect(accounts).toHaveLength(0) // the new link was never created

    await cleanupSeed()
  })
})

describe('resolveLinkRequest — reject (R12)', () => {
  it('closes the request as rejected without creating any ba_accounts row', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('reject-collision-target')
    const requestId = await seedPendingRequest('reject-directory-username', matchedUserId)

    const result = await resolveLinkRequest({ requestId, action: 'reject' }, RESOLVING_ADMIN)

    expect(result.status).toBe('rejected')

    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe('rejected')

    const accounts = await db
      .select()
      .from(baAccounts)
      .where(
        and(
          eq(baAccounts.providerId, 'ldap'),
          eq(baAccounts.accountId, 'reject-directory-username')
        )
      )
    expect(accounts).toHaveLength(0)

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'user'),
          eq(auditLogs.entityId, matchedUserId),
          eq(auditLogs.action, 'ldap.link_rejected')
        )
      )
    expect(audit).toBeDefined()

    await cleanupSeed()
  })
})

describe('resolveLinkRequest — concurrent resolution race (R12, FIX 3)', () => {
  // FIX 3 (P2 code review): closeRequest's UPDATE previously had no
  // `WHERE status = 'pending'` guard, so a losing concurrent resolution
  // could silently overwrite an already-linked/rejected request's status
  // -- e.g. a losing `reject` flipping a just-committed `link` back to
  // `rejected`, even though the `link`'s `ba_accounts` row had already
  // been created. Two REAL concurrent resolutions (one `link`, one
  // `reject`) racing the same pending request must now resolve to exactly
  // one success and one typed `LdapLinkRequestAlreadyResolvedError`, and
  // the final DB status must match whichever one actually won -- never
  // flipped by the loser.
  it('when link and reject race the same pending request, exactly one wins and the final status matches the winner', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('race-collision-target')
    const targetUserId = await seedLocalUser('race-chosen-target')
    const requestId = await seedPendingRequest('race-directory-username', matchedUserId)

    const results = await Promise.allSettled([
      resolveLinkRequest({ requestId, action: 'link', targetUserId }, RESOLVING_ADMIN),
      resolveLinkRequest({ requestId, action: 'reject' }, RESOLVING_ADMIN),
    ])

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveLinkRequest>>> =>
        r.status === 'fulfilled'
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(rejected[0]?.reason).toBeInstanceOf(LdapLinkRequestAlreadyResolvedError)

    const winnerStatus = fulfilled[0]?.value.status
    expect(['linked', 'rejected']).toContain(winnerStatus)

    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe(winnerStatus)

    // If `link` won, its ba_accounts row was actually committed; if
    // `reject` won, no ba_accounts row exists -- a `link` that lost the
    // closeRequest compare-and-swap rolls its own insert back atomically
    // with the rest of its transaction.
    const accounts = await db
      .select()
      .from(baAccounts)
      .where(
        and(eq(baAccounts.providerId, 'ldap'), eq(baAccounts.accountId, 'race-directory-username'))
      )
    if (winnerStatus === 'linked') {
      expect(accounts).toHaveLength(1)
      expect(accounts[0]?.userId).toBe(targetUserId)
    } else {
      expect(accounts).toHaveLength(0)
    }

    await cleanupSeed()
  })
})

describe('resolveLinkRequest — idempotency on an already-resolved request (R12)', () => {
  it('rejects re-resolving an already-linked request with a typed error, not a 500', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('idempotent-collision-target')
    const targetUserId = await seedLocalUser('idempotent-chosen-target')
    const requestId = await seedPendingRequest('idempotent-directory-username', matchedUserId)

    const first = await resolveLinkRequest(
      { requestId, action: 'link', targetUserId },
      RESOLVING_ADMIN
    )
    expect(first.status).toBe('linked')

    await expect(
      resolveLinkRequest({ requestId, action: 'reject' }, RESOLVING_ADMIN)
    ).rejects.toThrow(LdapLinkRequestAlreadyResolvedError)

    // Still linked -- the second call did not silently flip it to rejected.
    const [row] = await db.select().from(ldapLinkRequests).where(eq(ldapLinkRequests.id, requestId))
    expect(row!.status).toBe('linked')

    await cleanupSeed()
  })

  it('rejects re-resolving an already-rejected request with a typed error', async () => {
    await cleanupSeed()
    const matchedUserId = await seedLocalUser('idempotent-reject-target')
    const requestId = await seedPendingRequest('idempotent-reject-username', matchedUserId)

    await resolveLinkRequest({ requestId, action: 'reject' }, RESOLVING_ADMIN)

    await expect(
      resolveLinkRequest({ requestId, action: 'reject' }, RESOLVING_ADMIN)
    ).rejects.toThrow(LdapLinkRequestAlreadyResolvedError)

    await cleanupSeed()
  })
})
