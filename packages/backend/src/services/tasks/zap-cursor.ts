/**
 * Opaque pagination cursor for the Agent API zaps endpoint
 * (`GET /api/v1/agent/tasks/{taskId}/zaps`).
 *
 * The agent treats the cursor as opaque: the server mints it in a
 * response's `nextCursor` and the agent echoes it back verbatim as the
 * `cursor` query param on the next call. Because the agent never parses
 * or constructs the token, the entire `>` vs `>=` / advance-the-cursor
 * bug class disappears — the server round-trips its own encoding and can
 * evolve it freely.
 *
 * Wire form: base64url of a compact JSON object `{ "c": <epochMillis>,
 * "i": <id> }` keyed on the composite `(crackedAt, id)` sort key the
 * zaps query orders by. base64url (not standard base64) keeps the token
 * query-safe with no `+`/`/`/`=` escaping.
 *
 * Precision (ms-aligned-writes invariant): `c` carries `crackedAt` as
 * epoch-MILLISECONDS, matching the millisecond precision the app can
 * observe. Although `hash_items.cracked_at` is a Postgres `timestamptz`
 * (microsecond-capable), EVERY write path sets it from a JavaScript
 * `Date` (`new Date()` in services/tasks.ts + hash-items/propagation.ts,
 * the JS-`Date`-fed `EXCLUDED.cracked_at` upserts in the queue workers,
 * and `new Date(...)` in scripts/migrate-data.ts) — there is no
 * `defaultNow()`/`now()` DB-side write. So the column only ever holds
 * millisecond-aligned values and `new Date(millis).getTime() === millis`
 * round-trips losslessly. Decode → `Date` → Drizzle `gt`/`eq` compares
 * exactly against the column, matching how `services/results/export.ts`
 * and `routes/dashboard/results.ts` keyset-paginate this same column.
 */
import { z } from '@hono/zod-openapi'

/**
 * Server-private composite cursor shape. Mirrors the internal
 * `CrackedCursor` in `services/results/export.ts` but is kept local to
 * the zaps feature — it is not an agent-facing wire shape (the agent
 * only ever sees the opaque base64url token).
 */
export type ZapCursor = { readonly crackedAt: Date; readonly id: number }

/** Upper bound for the `id` field — matches the PostgreSQL int4 / `serial` ceiling. */
const MAX_PG_INT4 = 2_147_483_647

/**
 * Upper bound for the epoch-millis `c` field — JavaScript `Date`'s valid
 * range ceiling (±8.64e15 ms from the epoch). Without this bound a
 * schema-valid-but-huge `c` passes `int().nonnegative()`, decodes to an
 * `Invalid Date`, and only surfaces when the bad `Date` reaches Drizzle's
 * comparator downstream — where it throws into the route's generic catch
 * and leaks a 500 instead of the 400 the contract promises for a
 * malformed cursor. Rejecting it at decode keeps every structurally
 * invalid token on the 400 path.
 */
const MAX_EPOCH_MILLIS = 8_640_000_000_000_000

/** Decoded token payload, validated defensively — the cursor is agent-controlled input. */
const cursorPayloadSchema = z
  .object({
    c: z.number().int().nonnegative().max(MAX_EPOCH_MILLIS),
    i: z.number().int().positive().max(MAX_PG_INT4),
  })
  .strict()

/**
 * Thrown when a cursor token cannot be decoded to a valid {@link ZapCursor}.
 * Carries a fixed, non-leaky message; the route maps it to the Agent API
 * validation-error envelope (400). Internal parse-exception text is never
 * surfaced to the agent.
 */
export class ZapCursorError extends Error {
  constructor() {
    super('Invalid cursor')
    this.name = 'ZapCursorError'
  }
}

/** Encode a composite cursor to an opaque base64url token. */
export function encodeZapCursor(cursor: ZapCursor): string {
  const payload = JSON.stringify({ c: cursor.crackedAt.getTime(), i: cursor.id })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

/**
 * Decode an opaque token back to a composite cursor. Rejects — by throwing
 * {@link ZapCursorError} — a token that is not valid base64url, does not
 * decode to JSON, does not match the expected shape, or carries an
 * out-of-range `id` or `crackedAt`. Never trusts the token.
 */
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
