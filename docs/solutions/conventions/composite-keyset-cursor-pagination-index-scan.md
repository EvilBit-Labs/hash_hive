---
module: packages/backend
date: 2026-07-14
status: active
problem_type: convention
component: api-contract
severity: high
tags:
  - cursor-pagination
  - keyset-pagination
  - composite-cursor
  - postgres
  - btree-index
  - explain-analyze
  - timestamp-precision
  - agent-api
applies_when:
  - "Building keyset/cursor pagination over a column that can hold duplicate values across rows (e.g. a wall-clock timestamp)"
  - "A single-column cursor (`since: Date`) is insufficient because more rows can share one value than fit in `limit`"
  - "Adding cursor-based pagination to a new Agent, Dashboard, or Control API endpoint that reuses the composite-keyset pattern"
  - "A composite (multi-column) keyset predicate is expressed as OR-expanded comparisons and needs to hit a btree index rather than degrade to a row-by-row Filter"
symptoms:
  - "A single-`Date` `since` cursor skips or replays rows when multiple rows share the same timestamp"
  - "Sub-millisecond precision mismatch between cursor encode, decode, and SQL comparison reintroduces skip/replay on ties even after moving to a composite cursor"
  - "EXPLAIN shows a sequential/row-by-row Filter instead of an index range scan for an OR-expanded composite keyset WHERE clause on a hot pagination path"
---

# Composite (timestamp, id) keyset cursor pagination for exactly-once cross-call polling

## Context

The Agent API's zaps endpoint (`GET /api/v1/agent/tasks/{taskId}/zaps`, issue #182) lets an agent poll for hashes that have already been cracked by any campaign sharing its task's hash list, so the agent can skip work it would otherwise duplicate. The endpoint paginates over `hash_items` ordered by `crackedAt`, a wall-clock timestamp set by the application whenever a hash is cracked.

The original implementation used a single-timestamp cursor: the caller passed `since: Date`, the service filtered `crackedAt > since`, and the response returned only `{ zaps: string[], hasMore: boolean }` — no cursor material to advance with. This is unsound the moment more than `limit` rows share one `crackedAt` value, which is common in this domain: hashcat agents crack hashes in batches, and many hash items land in the database with the same millisecond timestamp. Advancing `since` to the max `crackedAt` seen in a page and re-querying with `>` silently **skips** the rest of the tied rows (they never appear in the next page). Re-querying with `>=` instead **replays** every row already returned. Neither behavior is acceptable for a cache-invalidation-style poll where "walk every cracked row exactly once" is the whole point — skipped rows mean an agent wastes cycles re-cracking a hash another agent already solved, and it has no way to detect the miss.

The fix (issue #182, PR #286) replaced the single-timestamp cursor with an opaque, composite `(crackedAt, id)` keyset cursor, mirroring the pattern already used by `services/results/export.ts` and `routes/dashboard/results.ts` for exporting cracked results.

## Guidance

1. **Order by a composite key `(timestamp, id)`**, where `id` is a unique, monotonically assigned tiebreaker (the serial primary key). This makes row order deterministic across calls even when many rows share one timestamp — the previous single-column `ORDER BY crackedAt` left tie order to whatever the query planner picked for physical storage, which is not guaranteed stable across separate queries.

2. **Make the cursor opaque and server-round-tripped, not a structured value on the wire.** The server mints a base64url token of a compact JSON payload (`{ c: epochMillis, i: id }`) into the response's `nextCursor` field; the client echoes it back verbatim as the `cursor` query parameter on the next call. The client never parses or constructs the token, so the entire `>` vs `>=` / "how do I advance the cursor" bug class disappears by construction — there is no client-side arithmetic to get wrong, and the server is free to change the internal encoding later without a client-side migration.

3. **`nextCursor` is always present in the response shape**: a token when more rows remain, an explicit `null` at exhaustion — never an absent key. This lets the client terminate its poll loop cleanly on `nextCursor === null` instead of inferring exhaustion from a separate `hasMore` boolean that could drift out of sync with the cursor value.

4. **The resume predicate is the boolean expansion of a row-value comparison.** Drizzle (like most query builders) has no native row-value operator, so `(crackedAt, id) > (cursor.crackedAt, cursor.id)` has to be written out as:
   `(crackedAt > cursor.crackedAt) OR (crackedAt = cursor.crackedAt AND id > cursor.id)`
   for ascending order. This is the general pattern for composite-keyset pagination in any query builder without row-value support, not something specific to this endpoint.

   **Gotcha — the comparator direction flips with sort order.** ASC pagination needs `gt`/`gt`; DESC pagination (as used in the sibling `results/export.ts` and `dashboard/results.ts`) needs `lt`/`lt`. Copying a DESC sibling's predicate into an ASC endpoint (or vice versa) without flipping every comparator is the single most likely bug when porting this pattern — write a real-DB test with deliberately tied timestamps that would fail silently (wrong subset, not a crash) if the direction were wrong.

5. **Gotcha — the OR predicate alone does not get pushed into a btree index.** Postgres evaluates `(ts > c) OR (ts = c AND id > c.id)` as a row-by-row Filter, not an Index Cond, so every page rescans the entire remaining range from the start of the index rather than seeking to the cursor position — per-page cost grows as the caller walks deeper into the result set. The fix is to add a **logically redundant** leading bound before the OR: `gte(ts, cursor.ts)`. Every row the OR admits also satisfies this `gte` (it's implied, not a tightening of the result set), but because it's a single-column inequality on the leading index column, Postgres's planner turns it into an actual Index Cond / index range scan, leaving the OR as a cheap in-range tie-break Filter over a much smaller candidate set. Verify with `EXPLAIN` — the query plan should show an Index Cond on the leading `gte`, not a full Filter-only scan. Mark the redundant bound with a `DO NOT REMOVE` comment: a later "dead code" or "redundant condition" cleanup pass will otherwise correctly notice it's logically implied by the OR and correctly-but-wrongly delete it, silently degrading a hot polling path back to a full-range rescan with every existing correctness test still green (the result set doesn't change, only its cost does).

6. **Gotcha — cursor precision must agree end-to-end with the column's write precision, not its declared column type.** The `crackedAt` column is a Postgres `timestamptz`, which is microsecond-capable, but Drizzle's default timestamp mode surfaces it to the application as a JS `Date`, which is millisecond-precision. If the cursor encodes at one precision and the SQL comparison runs at another, ties can be missed or duplicated at the sub-millisecond boundary. This works safely here specifically because **every write path** to `crackedAt` sets it from a JS `Date` — there is no `now()`/`defaultNow()` DB-side default anywhere in the write path (`services/tasks.ts`, `hash-items/propagation.ts`, the BullMQ queue workers' `EXCLUDED.cracked_at` upserts, and `scripts/migrate-data.ts` all construct `new Date()`). Because the column therefore only ever holds millisecond-aligned values, `new Date(millis).getTime() === millis` round-trips losslessly and a millisecond-precision cursor is sufficient. Treat the guarantee as resting on the "all writes go through a JS `Date`" invariant, not on the column's declared type — if a future migration or DB-side trigger ever writes `crackedAt` via `now()` directly, this invariant breaks silently. Pin the assumption with an inline comment at the write sites and a tied-timestamp real-DB test that would catch a precision mismatch.

7. **Validate the cursor defensively at the request boundary**, because it is client-controlled input even though the client is expected to treat it as opaque — nothing stops a malicious or buggy agent from sending an arbitrary string. Decode inside the route's Zod query schema (a `.transform`), not inside the service: a malformed, truncated, or wrong-shape token should become a clean 400 `VALIDATION_ERROR`, never the service's 404 "not found" path and never an uncaught 500. Bound **both** cursor fields defensively:
   - The raw token string itself, before base64url-decode + `JSON.parse` even run, so a multi-megabyte query value can't force wasted decode/parse work on a hot polling path.
   - The decoded `c` (epoch millis) against JS `Date`'s valid range ceiling (`±8.64e15` ms). A schema that only checks `int().nonnegative()` lets an absurdly large-but-structurally-valid `c` through, which decodes to an `Invalid Date` and only surfaces when that `Date` reaches Drizzle's comparator downstream — as an opaque 500, not the 400 the contract promises for a malformed cursor.
   - The decoded `i` (id) against the database's actual `int4` ceiling, shared from one constant so the route's boundary check and the column's real limit can't drift apart.

8. **The exactly-once guarantee depends on the timestamp being write-once-forward (monotonic per row).** If a row's `crackedAt` can only move forward on any re-write, the worst-case failure mode if a cursor is replayed is a benign duplicate (the agent re-sees an already-zapped hash — wasted cycles, no correctness impact). If a re-write could ever move `crackedAt` backward — an NTP step, a backfill script setting an earlier timestamp, or a future feature that treats it as mutable — the pagination could reintroduce silent skips, because a "already walked past" row could reappear behind the cursor's position. Confirm no write path in the codebase moves this column backward before relying on this pattern for a new column.

## Why This Matters

This pattern gets three things right simultaneously that are each individually easy to get wrong and, once wrong, fail silently:

- **Correctness under ties**: the composite `(timestamp, id)` cursor is what makes "walk every row exactly once" actually true when many rows share a timestamp — the single-`since`-cursor version either skipped or replayed tied rows depending on which comparator was chosen, and both failure modes pass every test that doesn't specifically construct tied timestamps.
- **Performance on a hot path**: the zaps endpoint is polled continuously by every active agent. Without the redundant `gte` pushdown, the query still returns the *correct* result set (functional correctness tests stay green) but degrades from an index seek to a growing rescan as an agent walks deeper into a large cracked set — a purely operational regression that no unit or integration test catches unless it specifically asserts on the query plan.
- **Boundary safety**: decoding and bounding the cursor at the Zod schema layer, rather than downstream in the service, is what keeps a malformed or hostile client input on the 400 path instead of leaking as a 500 or a misleading 404. This is the general principle that any client-controlled opaque token still needs input validation, even though the client itself is expected never to construct one.

Because all three failure modes are silent — they don't throw, they don't fail existing tests, they just quietly return the wrong subset of rows, run slower, or leak an unhandled exception under adversarial input — this is exactly the kind of defect that compounds unnoticed until it's chased down against production polling data.

## When to Apply

Apply this pattern whenever a new endpoint (Agent, Dashboard, or Control API surface) needs keyset/cursor pagination over a column that is not guaranteed unique — most commonly a timestamp like `crackedAt`, `createdAt`, or `updatedAt`, but the same reasoning applies to any non-unique ordering key. It does not apply to pagination over a column that is already unique and monotonic (e.g., a bare serial `id`), where a simple `id > cursor.id` predicate is sufficient and the composite-key machinery is unnecessary complexity.

Two existing endpoints already use the composite `(crackedAt, id)` cursor in DESC order: `packages/backend/src/services/results/export.ts` (`createDefaultCrackedFetcher`) and `packages/backend/src/routes/dashboard/results.ts`. A new endpoint paginating over `crackedAt` or a similar column should mirror their shape (and this zaps endpoint's ASC variant), and should specifically re-verify gotchas 5 through 7 above — the index-pushdown `gte`/`lte` bound, the timestamp-precision invariant, and boundary-layer cursor validation — rather than assuming they carry over automatically from the sibling implementation.

## Examples

**Before — single-timestamp `since` cursor (unsound under ties, no way to resume):**

```typescript
// packages/backend/src/services/tasks/zaps.ts (pre-#182)
export async function getZapsForTask(
  taskId: number,
  agentId: number,
  projectId: number,
  opts: { since?: Date | undefined; limit?: number | undefined } = {}
): Promise<{ zaps: string[]; hasMore: boolean } | { error: string }> {
  // ...
  const conditions = [eq(hashItems.hashListId, taskRow.hashListId), isNotNull(hashItems.crackedAt)]

  if (opts.since) {
    conditions.push(gt(hashItems.crackedAt, opts.since))
  }

  // Ordering uses `(crackedAt, id)` so tied rows resolve deterministically,
  // but resilient pagination across ties still needs a composite cursor on
  // the wire (`since` is a single Date today) — tracked in #182.
  const rows = await db
    .select({ hashValue: hashItems.hashValue })
    .from(hashItems)
    .where(and(...conditions))
    .orderBy(hashItems.crackedAt, hashItems.id)
    .limit(fetchLimit + 1)

  const hasMore = rows.length > fetchLimit
  const zaps = (hasMore ? rows.slice(0, fetchLimit) : rows).map((r) => r.hashValue)

  return { zaps, hasMore }
}
```

If more than `fetchLimit` rows shared one `crackedAt`, advancing `since` to that max timestamp and calling again with `since` re-applied as `>` dropped every tied row past the first page. There was also no field in the response to carry a richer cursor even if the caller wanted one.

**After — composite `(crackedAt, id)` cursor with index-pushdown `gte`:**

```typescript
// packages/backend/src/services/tasks/zaps.ts
const conditions: Array<SQL | undefined> = [
  eq(hashItems.hashListId, taskRow.hashListId),
  isNotNull(hashItems.crackedAt),
]

if (opts.cursor) {
  conditions.push(
    // Logically redundant with the OR below, but load-bearing for the query
    // plan: it restores an Index Cond range bound on
    // hash_items_hash_list_cracked_idx so Postgres seeks instead of
    // Filter-scanning the whole remaining range each page. DO NOT REMOVE.
    gte(hashItems.crackedAt, opts.cursor.crackedAt),
    or(
      gt(hashItems.crackedAt, opts.cursor.crackedAt),
      and(eq(hashItems.crackedAt, opts.cursor.crackedAt), gt(hashItems.id, opts.cursor.id))
    )
  )
}

const rows = await db
  .select({ hashValue: hashItems.hashValue, id: hashItems.id, crackedAt: hashItems.crackedAt })
  .from(hashItems)
  .where(and(...conditions))
  .orderBy(hashItems.crackedAt, hashItems.id)
  .limit(fetchLimit + 1)

const hasMore = rows.length > fetchLimit
const page = hasMore ? rows.slice(0, fetchLimit) : rows
const zaps = page.map((r) => r.hashValue)

let nextCursor: string | null = null
if (hasMore) {
  const lastRow = page.at(-1)!
  nextCursor = encodeZapCursor({ crackedAt: lastRow.crackedAt!, id: lastRow.id })
}

return { zaps, nextCursor }
```

**The opaque base64url codec** (`packages/backend/src/services/tasks/zap-cursor.ts`):

```typescript
const MAX_EPOCH_MILLIS = 8_640_000_000_000_000 // JS Date's valid range ceiling

const cursorPayloadSchema = z
  .object({
    c: z.number().int().nonnegative().max(MAX_EPOCH_MILLIS),
    i: z.number().int().positive().max(MAX_PG_INT4),
  })
  .strict()

export function encodeZapCursor(cursor: ZapCursor): string {
  const payload = JSON.stringify({ c: cursor.crackedAt.getTime(), i: cursor.id })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeZapCursor(token: string): ZapCursor {
  let payload: unknown
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8')
    payload = JSON.parse(json)
  } catch {
    throw new ZapCursorError()
  }

  const parsed = cursorPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new ZapCursorError()
  }

  return { crackedAt: new Date(parsed.data.c), id: parsed.data.i }
}
```

**Decode-at-the-boundary in the route's Zod query schema** (`packages/backend/src/routes/agent/index.ts`), turning a malformed token into a clean 400 rather than a service-layer 404 or an unhandled 500:

```typescript
const MAX_ZAP_CURSOR_LEN = 512
const zapQuerySchema = z.object({
  cursor: z
    .string()
    .max(MAX_ZAP_CURSOR_LEN)
    .optional()
    .transform((token, ctx) => {
      if (token === undefined || token === '') {
        return undefined // absent or empty → start from the beginning
      }
      try {
        return decodeZapCursor(token)
      } catch (err) {
        if (err instanceof ZapCursorError) {
          ctx.addIssue({ code: 'custom', message: 'Invalid cursor' })
          return z.NEVER
        }
        throw err // an unexpected error is a server bug, not bad client input
      }
    }),
  limit: z.coerce.number().int().min(1).max(MAX_ZAPS_LIMIT).default(MAX_ZAPS_LIMIT),
})
```

Because `decodeZapCursor` runs inside the Zod `.transform` at the route boundary, a malformed cursor becomes a Zod issue that routes through `agentOpenApiHonoOptions.defaultHook` to a 400 `VALIDATION_ERROR` — never reaching the service, so it can't be misreported as the service's "task not found" 404 or crash into a 500.

## Related

- **Sibling implementations (the DESC variant of this pattern):** `packages/backend/src/services/results/export.ts` (`createDefaultCrackedFetcher`, `CrackedCursor`) and `packages/backend/src/routes/dashboard/results.ts` (`fetchCsvBatch`) — the same composite `(crackedAt, id)` keyset cursor, ordered DESC (`lt` comparators). Mirror these when adding a new paginated endpoint; note the ASC/DESC comparator flip (gotcha 4) and that these DESC paths do **not** currently carry the redundant `gte`/`lte` index-pushdown bound (gotcha 5) — a candidate follow-up if they ever run hot.
- [`contract-test-mocks-mirror-service-not-schema.md`](./contract-test-mocks-mirror-service-not-schema.md) — the contract-test convention that governs `getZapsForTask`'s mocks. Its worked example still shows the pre-#182 `{ zaps, hasMore }` return shape; the real signature is now `{ zaps, nextCursor: string | null } | { error }`. Flagged for a refresh pass.
- [`dashboard-read-endpoint-contract.md`](./dashboard-read-endpoint-contract.md) — the read-endpoint wire-contract convention for the sibling dashboard surface (shared Zod schema, route-as-spec, integration round-trip). Complementary; that doc governs the contract shape, this one governs the pagination semantics inside it.
- [`shared-zod-openapi-wire-contract-mirror-2026-05-25.md`](./shared-zod-openapi-wire-contract-mirror-2026-05-25.md) — the rule that wire-crossing shapes live in `@hashhive/shared` as Zod schemas. Relevant boundary: the opaque `cursor`/`nextCursor` are wire-crossing (declared in the route's OpenAPI schema); the decoded `{ crackedAt, id }` `ZapCursor` is deliberately server-private and stays local.
- [`pre-prod-wire-rename-and-schema-version-bump.md`](./pre-prod-wire-rename-and-schema-version-bump.md) — precedent for a pre-production wire-contract breaking change with no compatibility shim, which is exactly how the `since` → `cursor`/`nextCursor` swap was landed (owner-authorized, agents regenerated off the spec).
- **Issue #182** — source issue (composite cursor for stable cross-call pagination); **PR #286** — the implementation. **PR #181** — landed the `ORDER BY (crackedAt, id)` groundwork this builds on.
- **AGENTS.md** — "All three surfaces are route-as-spec via `@hono/zod-openapi`"; the served `openapi.json` regenerates from the `createRoute` definition, so the cursor/nextCursor contract and the documented breaking change live in the route, not a separate YAML.
