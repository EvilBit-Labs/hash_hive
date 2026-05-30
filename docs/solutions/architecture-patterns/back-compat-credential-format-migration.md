---
title: "Back-compat credential format migration (plaintext → bcrypt with rotation window)"
date: 2026-05-30
problem_type: architecture_pattern
component: authentication
severity: high
module: packages/backend/src/middleware, packages/backend/src/lib, packages/shared/src/db
applies_when:
  - "Migrating a stored credential from a weaker format (plaintext, MD5, low-cost hash) to a stronger one without a downtime window"
  - "Some credential holders cannot rotate immediately (air-gapped agents, embedded clients without a rotation channel)"
  - "The migration must run forward-only -- no DOWN migration, no destructive column reuse"
tags:
  - security
  - migration
  - bcrypt
  - back-compat
  - rotation-window
  - partial-unique-index
  - check-constraint
  - drizzle
related_components:
  - database
  - tooling
---

# Back-compat credential format migration (plaintext → bcrypt with rotation window)

## Context

Pre-S-H2, agent bearer tokens were stored as raw UUIDs in `agents.auth_token`. A DB backup or read primitive surfaced live credentials. The upgrade had to happen with no downtime and no requirement that every agent rotate before the deploy: agents live on air-gapped LANs and rotation requires an operator-mediated out-of-band channel. The migration shipped in PR #180.

The pattern below is the shape that survived the constraints. It generalizes to any credential format upgrade -- API keys, session tokens, password hashes from a weaker algorithm -- where some holders can rotate immediately and others need a window.

## Guidance

Five moving parts, all in one forward-only migration:

### 1. Keep the legacy column but drop its `NOT NULL` and `UNIQUE`

```sql
ALTER TABLE "agents" DROP CONSTRAINT "agents_auth_token_unique";
ALTER TABLE "agents" ALTER COLUMN "auth_token" DROP NOT NULL;
```

Legacy rows still authenticate via the column. Newly-rotated rows have `NULL` here. Dropping `UNIQUE` is required because the partial unique index (step 4) replaces it; dropping `NOT NULL` is required because bcrypt-format rows clear the column.

### 2. Add the new format column + a format discriminator

```sql
ALTER TABLE "agents" ADD COLUMN "auth_token_hash" varchar(255);
ALTER TABLE "agents" ADD COLUMN "auth_token_format" varchar(16)
  DEFAULT 'plaintext' NOT NULL;
```

The discriminator is the runtime branch point. The auth middleware reads it and chooses verify path: plaintext column-compare, or bcrypt verify against `auth_token_hash`.

### 3. Pick a token shape that lets the auth path skip the discriminator query

New tokens look like `agt_<agentId>_<random>`. The `agt_` prefix is the format signal; the `<agentId>` is a routing hint so the middleware can fetch the row in O(1) before doing the bcrypt verify. Trust still flows from the verify, never the hint -- the hint is not a secret.

```ts
// packages/backend/src/lib/agent-token.ts
export function parseAgentToken(token: string): ParsedAgentToken | null {
  if (!token.startsWith('agt_')) return null
  // ... parse <agentId> and <random>
}
```

This lets the middleware branch on token shape, not row state:

```ts
const parsed = parseAgentToken(token)
if (parsed) {
  // bcrypt path: lookup by id, verify hash
} else {
  // legacy path: SELECT WHERE auth_token = ?
}
```

### 4. Partial UNIQUE index preserves legacy invariants

```sql
CREATE UNIQUE INDEX "agents_auth_token_plaintext_unique"
  ON "agents" USING btree ("auth_token")
  WHERE "agents"."auth_token_format" = 'plaintext'
    AND "agents"."auth_token" IS NOT NULL;
```

The pre-migration invariant was `agents.auth_token UNIQUE NOT NULL`. After step 1 dropped the constraint, two legacy plaintext rows could in principle collide. The partial unique index restores the constraint *for the rows that still need it*: legacy plaintext rows where `auth_token IS NOT NULL`. Bcrypt-format rows (which carry `auth_token = NULL`) are excluded and can coexist freely.

### 5. CHECK constraint pins the discriminator vocabulary

```sql
ALTER TABLE "agents" ADD CONSTRAINT "agents_auth_token_format_chk"
  CHECK ("agents"."auth_token_format" IN ('plaintext', 'bcrypt'));
```

A future bad migration or a direct UPDATE that lands `'pbkdf2'` or `'plain'` (typo) would silently break auth routing. The CHECK fails loud at write time.

### 6. Rotation endpoint is atomic + admin-only + one-shot reveal

```ts
// packages/backend/src/services/agents.ts
export async function rotateAgentToken(
  agentId: number,
  projectId: number,
): Promise<{ token: string } | null> {
  const { token, hash } = await generateAgentToken(agentId)
  const [updated] = await db
    .update(agents)
    .set({
      authToken: null,            // clear the legacy column
      authTokenHash: hash,         // write the bcrypt hash
      authTokenFormat: 'bcrypt',   // flip the discriminator
      updatedAt: new Date(),
    })
    .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
    .returning({ id: agents.id })
  if (!updated) return null
  return { token }
}
```

Single statement -- no half-rotated state where the row carries both a usable legacy token AND a usable bcrypt token. The raw token is returned exactly once and never persisted. Route adds `Cache-Control: no-store`.

## Why This Matters

- **No downtime.** The deploy doesn't gate on agents rotating. Legacy agents keep working through the rotation window.
- **No silent regression.** The CHECK constraint catches typos. The partial UNIQUE constraint catches duplicate-legacy-token bugs that step 1 would otherwise enable.
- **No half-rotated state.** Atomic UPDATE means failure leaves the agent on its existing legacy token; partial success is impossible.
- **Forward-only friendly.** Every step is additive or transforms-in-place. The eventual DROP COLUMN (after all agents have rotated) is a separate later release.

## When to Apply

Apply when **all** of:

- Stored credential needs format upgrade (algorithm, hash cost, structure).
- Some holders cannot rotate at deploy time.
- Forward-only migration policy (no DOWN, no destructive reuse).

Do **not** apply when:

- Every credential holder can rotate before the deploy (then a single migration that hashes-in-place + drops the legacy column is simpler).
- The new format can be derived from the old at rest (e.g., adding a salt the application already knows). The discriminator + dual-path machinery is overhead the simpler case doesn't need.

## Examples

S-H2 in PR #180:

- Migration: `packages/shared/src/db/migrations/0014_silky_multiple_man.sql`
- Library: `packages/backend/src/lib/agent-token.ts`
- Middleware: `packages/backend/src/middleware/auth.ts` (branch on `parseAgentToken` result)
- Service: `packages/backend/src/services/agents.ts` (`rotateAgentToken`)
- Route: `packages/backend/src/routes/dashboard/agents.ts` (`POST /agents/:id/rotate-token`)
- Operator runbook: `docs/operations/agent-token-rotation.md`
- SECURITY.md note: rotation-window disclosure

## Related

- `SECURITY.md` -- "rotation-window note" describes the in-flight state.
- `docs/operations/agent-token-rotation.md` -- operator-side runbook.
- `packages/backend/src/lib/api-key.ts` -- the Control API key pattern this migration mirrored (bcrypt + prefix + timing-uniform compare).
