/**
 * Export service for hash items (issue #102, unit U3).
 *
 * Implements cursor-paginated export of cracked/uncracked hash items in
 * CSV, hashcat-potfile, and john-potfile formats.
 *
 * Design notes:
 *   - `db` is always passed explicitly. This module has NO module-scope db
 *     import, so it loads in test phases without a live DB connection.
 *   - Batch fetchers and the skip counter are injectable for unit tests.
 *   - `skippedCount` is resolved BEFORE streaming so callers can emit it
 *     in an HTTP response header (headers precede the body).
 *   - KTD5: potfile lines are `${hashValue}:${plaintext}`. The stored
 *     hashValue for salted modes already contains `hash:salt`, so no
 *     reconstruction is needed on export — just concatenate.
 */

import type { ExportFormat, ExportVariant } from '@hashhive/shared'

import {
  attacks,
  campaigns,
  hashItems,
  hashLists,
  hashTypes,
  projectCrackedHashes,
} from '@hashhive/shared'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'

import type { db as _db } from '../../db/index.js'

// Exported so `tests/db/scope-helpers-parity.db.test.ts` (#202 code review
// fix) can drive `resolveHashListScopeForExport` with the real shared `db`
// client and assert it stays byte-for-byte in lockstep with
// `resolveHashListScope` in `services/hash-items/list-scope.ts`.
export type Db = typeof _db

// ─── CSV formula injection guard ────────────────────────────────────────────────

// Characters that trigger formula evaluation when they appear at the start of a
// cell in Excel / Google Sheets / LibreOffice. `plaintext` and `hashValue` are
// attacker-influenced data. Quote-wrapping alone does not neutralise this;
// the canonical mitigation is a leading apostrophe so the cell is treated as
// literal text. See OWASP "CSV Injection".
const CSV_FORMULA_TRIGGER_REGEX = /^[=+\-@\t\r\n]/

/**
 * Encode a string value for use as a CSV cell (RFC 4180 + OWASP injection guard).
 */
export function escapeCsv(val: string | null | undefined): string {
  if (val == null) return ''
  let str = val
  if (CSV_FORMULA_TRIGGER_REGEX.test(str)) {
    str = `'${str}`
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// ─── John potfile format-tag map ────────────────────────────────────────────────

/**
 * Conservative hashcat-mode → John-the-Ripper format-tag mapping.
 *
 * Only modes with a confirmed, unambiguous john potfile prefix are listed.
 * Unlisted modes are skip-counted at export time rather than guessed:
 * an incorrect tag produces a silently invalid potfile, which is worse
 * than a counted omission.
 *
 * NOT mapped (intentionally):
 *   - Crypt variants (500 / 1800 / 3200): stored hashValue already contains a
 *     self-identifying prefix (`$1$`, `$6$`, `$2y$`). Adding a john tag here
 *     would double-prefix and break the format.
 *   - SHA-1 (100): the john `$dynamic_N$` index is not stable across builds.
 */
export const JOHN_FORMAT_TAGS: Readonly<Partial<Record<number, string>>> = {
  0: '$dynamic_0$', // MD5 (raw, unsalted)
  1000: '$NT$', // NTLM
} as const

// Numeric array used for NOT IN queries; derived from the map so both stay in sync.
const JOHN_MAPPED_MODES: readonly number[] = Object.keys(JOHN_FORMAT_TAGS).map(Number)

// ─── Emittability predicate ─────────────────────────────────────────────────────

/**
 * Returns true when a row with the given hashcat mode can be emitted in the
 * requested format.
 *
 *   - csv:            always emittable (hash type is not required for CSV output)
 *   - hashcat-potfile: emittable when hashcatMode is known (list has a hash type)
 *   - john-potfile:   emittable only when mode has a known john format tag
 */
export function isEmittable(hashcatMode: number | null, format: ExportFormat): boolean {
  if (format === 'csv') return true
  if (hashcatMode === null) return false
  if (format === 'hashcat-potfile') return true
  return JOHN_MAPPED_MODES.includes(hashcatMode)
}

// ─── Row types ──────────────────────────────────────────────────────────────────

/** Row shape returned by the cracked batch fetcher. */
export type CrackedBatchRow = {
  readonly id: number
  readonly hashValue: string
  readonly plaintext: string | null
  readonly crackedAt: Date | null
  readonly username: string | null
  readonly source: string | null
  readonly hashListName: string | null
  readonly campaignName: string | null
  readonly attackMode: number | null
  readonly hashcatMode: number | null
}

/** Row shape returned by the uncracked batch fetcher. */
export type UncrackedBatchRow = {
  readonly id: number
  readonly hashValue: string
}

// ─── CSV headers ───────────────────────────────────────────────────────────────

export const EXPORT_CSV_HEADERS = {
  'cracked-pairs': 'hash_value,plaintext,username,source,campaign,attack,hash_list,cracked_at',
  'plaintext-only': 'plaintext',
  uncracked: 'hash_value',
} as const satisfies Record<ExportVariant, string>

// ─── Row encoding ───────────────────────────────────────────────────────────────

function encodeAsCsvLine(row: CrackedBatchRow, variant: ExportVariant): string {
  if (variant === 'plaintext-only') {
    return escapeCsv(row.plaintext)
  }
  return [
    escapeCsv(row.hashValue),
    escapeCsv(row.plaintext),
    escapeCsv(row.username),
    escapeCsv(row.source),
    escapeCsv(row.campaignName),
    row.attackMode != null ? String(row.attackMode) : '',
    escapeCsv(row.hashListName),
    row.crackedAt != null ? row.crackedAt.toISOString() : '',
  ].join(',')
}

/**
 * Encode a cracked row as a single export line for the given variant/format.
 *
 * Returns `null` when the row cannot be emitted (hash type missing or mode
 * unsupported for the requested format). The caller counts these omissions
 * and exposes them via `skippedCount`.
 */
export function encodeCrackedRow(
  row: CrackedBatchRow,
  variant: ExportVariant,
  format: ExportFormat
): string | null {
  if (!isEmittable(row.hashcatMode, format)) return null
  if (format === 'csv') return encodeAsCsvLine(row, variant)
  // Potfile formats require a plaintext value; a null plaintext produces a
  // malformed `hash:` line. Skip these rows — the pre-counted skippedCount
  // header accounts for them (see createDefaultSkippedCounter).
  if (row.plaintext == null) return null
  if (format === 'hashcat-potfile') {
    // KTD5: hashValue already contains `hash:salt` for salted modes;
    // export is always `hashValue:plaintext` — no reconstruction needed.
    return `${row.hashValue}:${row.plaintext}`
  }
  // john-potfile — tag is guaranteed non-null because isEmittable passed
  const tag = JOHN_FORMAT_TAGS[row.hashcatMode!]!
  return `${tag}${row.hashValue}:${row.plaintext}`
}

/**
 * Encode an uncracked row as a single CSV line (hash_value column only).
 */
export function encodeUncrackedRow(row: UncrackedBatchRow): string {
  return escapeCsv(row.hashValue)
}

// ─── Scope + service params ─────────────────────────────────────────────────────

type HashListScopeParams = { scope: 'hash-list'; projectId: number; hashListId: number }
type CampaignScopeParams = { scope: 'campaign'; projectId: number; campaignId: number }
type ProjectScopeParams = { scope: 'project'; projectId: number }
type SuperScopeParams = { scope: 'super'; projectId: number; superHashListId: number }

export type ExportScopeParams =
  | HashListScopeParams
  | CampaignScopeParams
  | ProjectScopeParams
  | SuperScopeParams

/** Optional search and date-range filters applied to export queries. */
export type ExportFilters = {
  readonly q?: string | undefined
  readonly startDate?: string | undefined
  readonly endDate?: string | undefined
}

export type ExportServiceParams = ExportScopeParams & {
  variant: ExportVariant
  format: ExportFormat
  /** Optional search/date filters to restrict exported rows. */
  filters?: ExportFilters
}

/**
 * Escape `%`, `_`, and `\` in a search term for use in ILIKE.
 *
 * Inlined here rather than imported from resources.ts because resources.ts
 * imports `db` at module scope, which would break the invariant that this
 * file loads in test phases without a live database connection.
 */
function escapeLikeForExport(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&')
}

/**
 * Resolve a hash-list scope id to `[id, ...childIds]` (#202 SU4).
 *
 * Mirrors `services/hash-items/list-scope.ts`'s `resolveHashListScope`
 * exactly (single query: `where (id = $1 or parent_hash_list_id = $1) and
 * project_id = $2`) but is duplicated rather than imported, for the same
 * reason as `escapeLikeForExport` above — that module imports `db` at
 * module scope, which would break this file's "no module-scope db import"
 * invariant. `db` is threaded through explicitly instead.
 *
 * Exported (code review fix, #202) ONLY so
 * `tests/db/scope-helpers-parity.db.test.ts` can call it directly against
 * the real shared `db` client and pin it against `resolveHashListScope` —
 * the two are intentionally-duplicated code, and without a test exercising
 * both, a future edit to one that silently diverges from the other (e.g. a
 * dropped `project_id` predicate) would go uncaught. No other caller
 * outside this module should use it; `createExport`'s `scope: 'hash-list'`
 * path is the production entrypoint.
 */
export async function resolveHashListScopeForExport(
  db: Db,
  id: number,
  projectId: number
): Promise<number[]> {
  const rows = await db
    .select({ id: hashLists.id })
    .from(hashLists)
    .where(
      and(
        or(eq(hashLists.id, id), eq(hashLists.parentHashListId, id)),
        eq(hashLists.projectId, projectId)
      )
    )
  return rows.map((r) => r.id)
}

// ─── Cursor types ───────────────────────────────────────────────────────────────

/** Keyset cursor for cracked-pairs / plaintext-only variants (crackedAt DESC, id DESC). */
export type CrackedCursor = { readonly crackedAt: Date; readonly id: number }

/** Keyset cursor for uncracked variant (id DESC only). */
export type UncrackedCursor = { readonly id: number }

// ─── Injectable types ───────────────────────────────────────────────────────────

export type CrackedBatchFetcher = (
  cursor: CrackedCursor | null
) => Promise<readonly CrackedBatchRow[]>

export type UncrackedBatchFetcher = (
  cursor: UncrackedCursor | null
) => Promise<readonly UncrackedBatchRow[]>

export type SkippedCounter = () => Promise<number>

export type ExportOverrides = {
  readonly batchSize?: number
  readonly fetchCrackedBatch?: CrackedBatchFetcher
  readonly fetchUncrackedBatch?: UncrackedBatchFetcher
  readonly countSkipped?: SkippedCounter
}

// ─── Default DB-backed implementations ─────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 1_000

/**
 * Builds the WHERE conditions for the cracked-rows export queries (batch
 * fetcher + skip counter).
 *
 * Returns `null` when the requested scope resolves to an empty set —
 * currently only possible for `scope: 'hash-list'`, where
 * `resolveHashListScopeForExport` returns `[]` for a cross-project or
 * nonexistent hash list id (IDOR guard). Callers must treat `null` as "zero
 * rows can match" and short-circuit before running a query, rather than
 * relying on Drizzle compiling `inArray(col, [])` to a false predicate.
 */
async function buildCrackedBaseConditions(
  db: Db,
  params: ExportScopeParams,
  filters?: ExportFilters
): Promise<SQL[] | null> {
  const base = [eq(hashLists.projectId, params.projectId), isNotNull(hashItems.crackedAt)]

  let withScope: SQL[]
  if (params.scope === 'hash-list') {
    const scopeIds = await resolveHashListScopeForExport(db, params.hashListId, params.projectId)
    if (scopeIds.length === 0) {
      return null
    }
    withScope = [...base, inArray(hashItems.hashListId, scopeIds)]
  } else if (params.scope === 'campaign') {
    withScope = [...base, eq(hashItems.campaignId, params.campaignId)]
  } else {
    withScope = base
  }

  const { q, startDate, endDate } = filters ?? {}
  const escapedQ = q != null ? escapeLikeForExport(q) : null

  return [
    ...withScope,
    ...(escapedQ != null
      ? [
          sql`(${hashItems.hashValue} ILIKE ${`%${escapedQ}%`} ESCAPE '\\' OR ${hashItems.plaintext} ILIKE ${`%${escapedQ}%`} ESCAPE '\\')`,
        ]
      : []),
    ...(startDate != null ? [gte(hashItems.crackedAt, new Date(startDate))] : []),
    ...(endDate != null ? [lte(hashItems.crackedAt, new Date(endDate))] : []),
  ]
}

async function createDefaultCrackedFetcher(
  db: Db,
  params: ExportScopeParams,
  batchSize: number,
  filters?: ExportFilters
): Promise<CrackedBatchFetcher> {
  const baseConditions = await buildCrackedBaseConditions(db, params, filters)
  if (baseConditions === null) {
    // IDOR guard: empty hash-list scope — no rows can match, return an
    // empty batch on every call without touching the database.
    return async () => []
  }

  return async (cursor) => {
    const conditions = [
      ...baseConditions,
      ...(cursor != null
        ? [
            or(
              lt(hashItems.crackedAt, cursor.crackedAt),
              and(eq(hashItems.crackedAt, cursor.crackedAt), lt(hashItems.id, cursor.id))
            ),
          ]
        : []),
    ]
    return db
      .select({
        id: hashItems.id,
        hashValue: hashItems.hashValue,
        plaintext: hashItems.plaintext,
        crackedAt: hashItems.crackedAt,
        username: hashItems.username,
        source: hashItems.source,
        hashListName: hashLists.name,
        campaignName: campaigns.name,
        attackMode: attacks.mode,
        hashcatMode: hashTypes.hashcatMode,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .leftJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
      .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
      .leftJoin(hashTypes, eq(hashLists.hashTypeId, hashTypes.id))
      .where(and(...conditions))
      .orderBy(desc(hashItems.crackedAt), desc(hashItems.id))
      .limit(batchSize)
  }
}

async function createDefaultUncrackedFetcher(
  db: Db,
  params: ExportScopeParams,
  batchSize: number,
  filters?: ExportFilters
): Promise<UncrackedBatchFetcher> {
  // q filter applies to uncracked rows (hashValue only; plaintext is NULL for uncracked).
  // Date filters are omitted — crackedAt is NULL for all uncracked rows by definition,
  // so a crackedAt date range would exclude every row in this variant.
  const escapedQ = filters?.q != null ? escapeLikeForExport(filters.q) : null

  // Resolved once, up front, rather than per-page inside the closure below
  // — a leaf list resolves to `[hashListId]` (identical to the pre-SU4
  // single-id filter); a split parent resolves to `[hashListId,
  // ...childIds]` (#202 SU4).
  const hashListScopeIds =
    params.scope === 'hash-list'
      ? await resolveHashListScopeForExport(db, params.hashListId, params.projectId)
      : null

  if (params.scope === 'hash-list' && hashListScopeIds !== null && hashListScopeIds.length === 0) {
    // IDOR guard: `resolveHashListScopeForExport` returns `[]` for a
    // cross-project or nonexistent hash list id. Short-circuit explicitly
    // rather than relying on Drizzle compiling `inArray(col, [])` to a
    // false predicate.
    return async () => []
  }

  return async (cursor) => {
    const baseConds = [
      eq(hashLists.projectId, params.projectId),
      isNull(hashItems.crackedAt),
      ...(escapedQ != null
        ? [sql`${hashItems.hashValue} ILIKE ${`%${escapedQ}%`} ESCAPE '\\'`]
        : []),
      ...(cursor != null ? [lt(hashItems.id, cursor.id)] : []),
    ]

    if (params.scope === 'hash-list' && hashListScopeIds != null) {
      return db
        .select({ id: hashItems.id, hashValue: hashItems.hashValue })
        .from(hashItems)
        .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
        .where(and(...baseConds, inArray(hashItems.hashListId, hashListScopeIds)))
        .orderBy(desc(hashItems.id))
        .limit(batchSize)
    }

    if (params.scope === 'campaign') {
      // Uncracked items in the hash list associated with this campaign.
      // campaignId is not set on uncracked hash_items rows, so we join
      // campaigns to resolve the list id without a separate query.
      return db
        .select({ id: hashItems.id, hashValue: hashItems.hashValue })
        .from(hashItems)
        .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
        .innerJoin(
          campaigns,
          and(eq(campaigns.id, params.campaignId), eq(campaigns.hashListId, hashItems.hashListId))
        )
        .where(and(...baseConds))
        .orderBy(desc(hashItems.id))
        .limit(batchSize)
    }

    // Project scope
    return db
      .select({ id: hashItems.id, hashValue: hashItems.hashValue })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .where(and(...baseConds))
      .orderBy(desc(hashItems.id))
      .limit(batchSize)
  }
}

function createDefaultSkippedCounter(
  db: Db,
  params: ExportScopeParams,
  format: ExportFormat,
  filters?: ExportFilters
): SkippedCounter {
  return async () => {
    if (format === 'csv') return 0

    // Rows are skipped when the list has no hash type (hashcatMode is null),
    // for john-potfile when the mode is not in the supported tag map, or
    // for either potfile format when plaintext is null (would produce `hash:` with
    // no plaintext — malformed). The null-plaintext term must appear here too
    // so skippedCount matches what encodeCrackedRow returns null for.
    const modeFilter =
      format === 'hashcat-potfile'
        ? or(isNull(hashTypes.id), isNull(hashItems.plaintext))
        : or(
            isNull(hashTypes.id),
            not(inArray(hashTypes.hashcatMode, [...JOHN_MAPPED_MODES])),
            isNull(hashItems.plaintext)
          )

    const baseConditions = await buildCrackedBaseConditions(db, params, filters)
    if (baseConditions === null) {
      // IDOR guard: empty hash-list scope — no rows can match, so nothing
      // can be skipped either.
      return 0
    }
    const conditions = [...baseConditions, modeFilter]

    const [row] = await db
      .select({ n: count(hashItems.id) })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .leftJoin(hashTypes, eq(hashLists.hashTypeId, hashTypes.id))
      .where(and(...conditions))

    return row?.n ?? 0
  }
}

// ─── Streaming generators ────────────────────────────────────────────────────────

async function* streamCrackedRows(
  fetchBatch: CrackedBatchFetcher,
  variant: ExportVariant,
  format: ExportFormat
): AsyncGenerator<string> {
  let cursor: CrackedCursor | null = null

  for (;;) {
    const batch = await fetchBatch(cursor)
    if (batch.length === 0) return

    for (const row of batch) {
      const line = encodeCrackedRow(row, variant, format)
      if (line != null) yield line
    }

    const last = batch[batch.length - 1]!
    cursor = { crackedAt: last.crackedAt!, id: last.id }
  }
}

async function* streamUncrackedRows(fetchBatch: UncrackedBatchFetcher): AsyncGenerator<string> {
  let cursor: UncrackedCursor | null = null

  for (;;) {
    const batch = await fetchBatch(cursor)
    if (batch.length === 0) return

    for (const row of batch) {
      yield encodeUncrackedRow(row)
    }

    const last = batch[batch.length - 1]!
    cursor = { id: last.id }
  }
}

// ─── Super-scope export (U14): deduplicated union + U4 crack resolution ─────────

/**
 * Keyset cursor for a super export.
 *
 * The dedup + pagination key is the composite `(coalesce(detected_hashcat_mode,
 * -1), hash_value)` — NOT `(crackedAt, id)` like the other scopes. A super
 * exports the DEDUPLICATED UNION of its leaves, so each `(mode, value)` must
 * appear once GLOBALLY across pages. `DISTINCT ON (coalesce(mode,-1), value)`
 * collapses cross-leaf duplicates within a page, and paginating on the SAME
 * composite the DISTINCT ON dedups on makes it global: a per-batch DISTINCT ON
 * with a `crackedAt` keyset would let a duplicate reappear on a later page.
 *
 * `detected_hashcat_mode` is nullable, so `coalesce(mode, -1)` is the sort/keyset
 * integer key: -1 is a safe sentinel below every real hashcat mode, and a no-mode
 * item (mode NULL → -1) never cross-list dedups against a real-mode item.
 */
type SuperCursor = { readonly coalescedMode: number; readonly hashValue: string }

type SuperCrackedRow = CrackedBatchRow & { readonly coalescedMode: number }
type SuperUncrackedRow = UncrackedBatchRow & { readonly coalescedMode: number }

type SuperCrackedFetcher = (cursor: SuperCursor | null) => Promise<readonly SuperCrackedRow[]>
type SuperUncrackedFetcher = (cursor: SuperCursor | null) => Promise<readonly SuperUncrackedRow[]>

/**
 * The `coalesce(detected_hashcat_mode, -1)` expression, reused verbatim in the
 * DISTINCT ON list, the ORDER BY, and the row-value keyset so Postgres treats
 * them as the same expression (DISTINCT ON requires its expressions to be the
 * leftmost ORDER BY terms).
 */
const SUPER_COALESCED_MODE_SQL = sql`coalesce(${hashItems.detectedHashcatMode}, -1)`

function superKeysetPredicate(cursor: SuperCursor): SQL {
  // Row-value comparison over `(coalesce(mode,-1), value)` — advances by the
  // exact composite the DISTINCT ON dedups on, so each pair is emitted once
  // across the whole paginated stream. Scalars only (int + text) — never a JS
  // array or Date in a bind position (postgres-js gotchas).
  return sql`(${SUPER_COALESCED_MODE_SQL}, ${hashItems.hashValue}) > (${cursor.coalescedMode}, ${cursor.hashValue})`
}

/**
 * Build the optional q/date filter predicates for the cracked super union.
 * `q` matches the hash value OR the RESOLVED plaintext (own row or cracked-set
 * fill); the date range is applied to the RESOLVED crack timestamp.
 *
 * `sql.param(date, hashItems.crackedAt)` is load-bearing on the date bounds:
 * `resolvedCrackedAt` is a raw SQL expression (a `COALESCE(...)` over the
 * cracked-set join), not a real column, so it gives Drizzle no column to
 * borrow an encoder from — a bare `Date` reaches postgres-js unserialized and
 * throws `ERR_INVALID_ARG_TYPE`. Naming `hashItems.crackedAt` supplies the
 * same timestamptz encoder (mirrors `routes/dashboard/results.ts`'s
 * `buildResultFilters`, which hits this exact expression).
 */
function superCrackedFilterConds(
  filters: ExportFilters | undefined,
  resolvedPlaintext: SQL<string | null>,
  resolvedCrackedAt: SQL<Date | null>
): SQL[] {
  const escapedQ = filters?.q != null ? escapeLikeForExport(filters.q) : null
  return [
    ...(escapedQ != null
      ? [
          sql`(${hashItems.hashValue} ILIKE ${`%${escapedQ}%`} ESCAPE '\\' OR ${resolvedPlaintext} ILIKE ${`%${escapedQ}%`} ESCAPE '\\')`,
        ]
      : []),
    ...(filters?.startDate != null
      ? [
          sql`${resolvedCrackedAt} >= ${sql.param(new Date(filters.startDate), hashItems.crackedAt)}`,
        ]
      : []),
    ...(filters?.endDate != null
      ? [sql`${resolvedCrackedAt} <= ${sql.param(new Date(filters.endDate), hashItems.crackedAt)}`]
      : []),
  ]
}

/**
 * Load the U4 SQL resolvers + node-resolution seam lazily.
 *
 * These modules import the shared `db` client at module scope; importing them
 * statically would break this file's "no module-scope db import, so it loads in
 * unit-test phases without a live DB" invariant (see the header). The super
 * fetchers are only ever built at runtime with a real `db`, so a dynamic import
 * here is safe and keeps the invariant intact.
 */
async function loadSuperResolvers() {
  const { resolveNodeToLeaves } = await import('../hash-items/node-resolution/index.js')
  const { crackedSetJoinOn, RESOLVED_IS_CRACKED, RESOLVED_CRACKED_AT, RESOLVED_PLAINTEXT } =
    await import('../hash-items/crack-resolution.js')
  return {
    resolveNodeToLeaves,
    crackedSetJoinOn,
    RESOLVED_IS_CRACKED,
    RESOLVED_CRACKED_AT,
    RESOLVED_PLAINTEXT,
  }
}

async function createSuperCrackedFetcher(
  db: Db,
  params: SuperScopeParams,
  leaves: number[],
  batchSize: number,
  filters?: ExportFilters
): Promise<SuperCrackedFetcher> {
  // `leaves` is resolved once by `createSuperExport` and threaded in (an empty
  // set is the IDOR guard — a cross-project/nonexistent super — so no query runs).
  if (leaves.length === 0) return async () => []

  const { crackedSetJoinOn, RESOLVED_IS_CRACKED, RESOLVED_CRACKED_AT, RESOLVED_PLAINTEXT } =
    await loadSuperResolvers()

  const filterConds = superCrackedFilterConds(filters, RESOLVED_PLAINTEXT, RESOLVED_CRACKED_AT)
  const coalescedMode = sql<number>`${SUPER_COALESCED_MODE_SQL}`.mapWith(Number)

  return async (cursor) => {
    const conditions: SQL[] = [
      inArray(hashItems.hashListId, leaves),
      RESOLVED_IS_CRACKED,
      ...filterConds,
      ...(cursor != null ? [superKeysetPredicate(cursor)] : []),
    ]
    return db
      .selectDistinctOn([SUPER_COALESCED_MODE_SQL, hashItems.hashValue], {
        id: hashItems.id,
        hashValue: hashItems.hashValue,
        // U4: own row wins, cracked-set only fills — resolved plaintext/time.
        plaintext: RESOLVED_PLAINTEXT,
        crackedAt: RESOLVED_CRACKED_AT,
        username: hashItems.username,
        source: hashItems.source,
        hashListName: hashLists.name,
        campaignName: campaigns.name,
        attackMode: attacks.mode,
        // Resolved per-item mode (a mixed super spans hash types), NOT
        // hashTypes.hashcatMode — used for potfile emittability.
        hashcatMode: hashItems.detectedHashcatMode,
        coalescedMode,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .leftJoin(projectCrackedHashes, crackedSetJoinOn(params.projectId))
      .leftJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
      .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
      .where(and(...conditions))
      .orderBy(sql`${SUPER_COALESCED_MODE_SQL} asc`, asc(hashItems.hashValue), asc(hashItems.id))
      .limit(batchSize)
  }
}

async function createSuperUncrackedFetcher(
  db: Db,
  params: SuperScopeParams,
  leaves: number[],
  batchSize: number,
  filters?: ExportFilters
): Promise<SuperUncrackedFetcher> {
  if (leaves.length === 0) return async () => []

  const { crackedSetJoinOn, RESOLVED_IS_CRACKED } = await loadSuperResolvers()

  // A value cracked ANYWHERE in the project resolves cracked (U4) and is thus
  // excluded from the uncracked union. Date filters are omitted — crackedAt is
  // NULL for every uncracked row, so a crackedAt range would exclude them all.
  const escapedQ = filters?.q != null ? escapeLikeForExport(filters.q) : null
  const filterConds =
    escapedQ != null ? [sql`${hashItems.hashValue} ILIKE ${`%${escapedQ}%`} ESCAPE '\\'`] : []
  const coalescedMode = sql<number>`${SUPER_COALESCED_MODE_SQL}`.mapWith(Number)

  return async (cursor) => {
    const conditions: SQL[] = [
      inArray(hashItems.hashListId, leaves),
      not(RESOLVED_IS_CRACKED),
      ...filterConds,
      ...(cursor != null ? [superKeysetPredicate(cursor)] : []),
    ]
    return db
      .selectDistinctOn([SUPER_COALESCED_MODE_SQL, hashItems.hashValue], {
        id: hashItems.id,
        hashValue: hashItems.hashValue,
        coalescedMode,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .leftJoin(projectCrackedHashes, crackedSetJoinOn(params.projectId))
      .where(and(...conditions))
      .orderBy(sql`${SUPER_COALESCED_MODE_SQL} asc`, asc(hashItems.hashValue), asc(hashItems.id))
      .limit(batchSize)
  }
}

/**
 * Skip counter for potfile super exports: how many rows of the DEDUPED cracked
 * union cannot be emitted (missing hash type, unsupported john mode, or null
 * plaintext). Counted over the same DISTINCT ON union the stream emits, so the
 * pre-stream `skippedCount` header matches what `encodeCrackedRow` drops.
 */
async function countSuperSkipped(
  db: Db,
  params: SuperScopeParams,
  leaves: number[],
  format: ExportFormat,
  filters?: ExportFilters
): Promise<number> {
  if (format === 'csv' || leaves.length === 0) return 0

  const { crackedSetJoinOn, RESOLVED_IS_CRACKED, RESOLVED_CRACKED_AT, RESOLVED_PLAINTEXT } =
    await loadSuperResolvers()

  const filterConds = superCrackedFilterConds(filters, RESOLVED_PLAINTEXT, RESOLVED_CRACKED_AT)

  const deduped = db
    .selectDistinctOn([SUPER_COALESCED_MODE_SQL, hashItems.hashValue], {
      mode: hashItems.detectedHashcatMode,
      plaintext: RESOLVED_PLAINTEXT,
    })
    .from(hashItems)
    .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
    .leftJoin(projectCrackedHashes, crackedSetJoinOn(params.projectId))
    .where(and(inArray(hashItems.hashListId, leaves), RESOLVED_IS_CRACKED, ...filterConds))
    .orderBy(sql`${SUPER_COALESCED_MODE_SQL} asc`, asc(hashItems.hashValue), asc(hashItems.id))
    .as('deduped')

  const skipPredicate =
    format === 'hashcat-potfile'
      ? or(isNull(deduped.mode), isNull(deduped.plaintext))
      : or(
          isNull(deduped.mode),
          not(inArray(deduped.mode, [...JOHN_MAPPED_MODES])),
          isNull(deduped.plaintext)
        )

  const [row] = await db.select({ n: count() }).from(deduped).where(skipPredicate)
  return row?.n ?? 0
}

async function* streamSuperCrackedRows(
  fetchBatch: SuperCrackedFetcher,
  variant: ExportVariant,
  format: ExportFormat
): AsyncGenerator<string> {
  let cursor: SuperCursor | null = null
  for (;;) {
    const batch = await fetchBatch(cursor)
    if (batch.length === 0) return
    for (const row of batch) {
      const line = encodeCrackedRow(row, variant, format)
      if (line != null) yield line
    }
    const last = batch[batch.length - 1]!
    cursor = { coalescedMode: last.coalescedMode, hashValue: last.hashValue }
  }
}

async function* streamSuperUncrackedRows(
  fetchBatch: SuperUncrackedFetcher
): AsyncGenerator<string> {
  let cursor: SuperCursor | null = null
  for (;;) {
    const batch = await fetchBatch(cursor)
    if (batch.length === 0) return
    for (const row of batch) {
      yield encodeUncrackedRow(row)
    }
    const last = batch[batch.length - 1]!
    cursor = { coalescedMode: last.coalescedMode, hashValue: last.hashValue }
  }
}

/**
 * Assemble the super export (deduplicated union with U4-resolved crack state).
 * Branched out of `createExport` so the `(crackedAt, id)`-keyset default
 * fetchers never see a super scope. Test overrides (`fetchCrackedBatch` etc.)
 * are keyed to the default `CrackedCursor` and deliberately do NOT apply here —
 * the super path is exercised via a real DB in `super-export.db.test.ts`.
 */
async function createSuperExport(
  db: Db,
  params: SuperScopeParams,
  variant: ExportVariant,
  format: ExportFormat,
  filters: ExportFilters | undefined,
  batchSize: number
): Promise<ExportResult> {
  // Resolve the super's leaf union ONCE here and thread it into the skip-counter
  // and the fetcher, rather than each of them re-resolving it from the DB (an
  // empty set is the IDOR guard, handled by each callee).
  const { resolveNodeToLeaves } = await loadSuperResolvers()
  const leaves = await resolveNodeToLeaves({
    kind: 'super',
    superHashListId: params.superHashListId,
    projectId: params.projectId,
  })

  const needsSkipCount = variant !== 'uncracked' && format !== 'csv'
  const skippedCount = needsSkipCount
    ? await countSuperSkipped(db, params, leaves, format, filters)
    : 0

  if (variant === 'uncracked') {
    const fetchBatch = await createSuperUncrackedFetcher(db, params, leaves, batchSize, filters)
    async function* uncrackedStream(): AsyncGenerator<string> {
      yield EXPORT_CSV_HEADERS.uncracked
      yield* streamSuperUncrackedRows(fetchBatch)
    }
    return { skippedCount, rows: uncrackedStream() }
  }

  const fetchBatch = await createSuperCrackedFetcher(db, params, leaves, batchSize, filters)
  async function* crackedStream(): AsyncGenerator<string> {
    if (format === 'csv') yield EXPORT_CSV_HEADERS[variant]
    yield* streamSuperCrackedRows(fetchBatch, variant, format)
  }
  return { skippedCount, rows: crackedStream() }
}

// ─── Public API ──────────────────────────────────────────────────────────────────

/** Result of `createExport`. */
export type ExportResult = {
  /**
   * Rows omitted because the hash type is missing or the mode is unsupported
   * for the requested format. Always 0 for CSV. Resolved before the stream
   * opens so callers can emit it in an HTTP response header.
   */
  readonly skippedCount: number

  /**
   * Async generator of export lines. For CSV the first line is the column
   * header. Lines do NOT include a trailing `\n`; callers append it when
   * encoding for transmission.
   */
  readonly rows: AsyncGenerator<string>
}

/**
 * Create a streamed export of hash items.
 *
 * @param db      Drizzle DB instance (passed explicitly; never imported at
 *                module scope so this file is loadable in test phases).
 * @param params  Scope, variant, and format for this export.
 * @param overrides Optional test doubles — inject these to unit-test without
 *                  a real database connection.
 */
export async function createExport(
  db: Db,
  params: ExportServiceParams,
  overrides: ExportOverrides = {}
): Promise<ExportResult> {
  const batchSize = overrides.batchSize ?? DEFAULT_BATCH_SIZE
  const { variant, format, filters } = params

  // Super scope (U14): deduplicated union with U4-resolved crack state. Handled
  // by a dedicated path whose dedup + keyset are over `(mode, value)`, not the
  // `(crackedAt, id)` keyset the other scopes use.
  if (params.scope === 'super') {
    return createSuperExport(db, params, variant, format, filters, batchSize)
  }

  // Skip-counting only applies to potfile formats — CSV emits every row regardless
  // of hash type. Uncracked rows can never produce a potfile (schema rejects it).
  const needsSkipCount = variant !== 'uncracked' && format !== 'csv'
  const skippedCount = needsSkipCount
    ? await (overrides.countSkipped ?? createDefaultSkippedCounter(db, params, format, filters))()
    : 0

  if (variant === 'uncracked') {
    const fetchBatch =
      overrides.fetchUncrackedBatch ??
      (await createDefaultUncrackedFetcher(db, params, batchSize, filters))

    async function* uncrackedStream(): AsyncGenerator<string> {
      yield EXPORT_CSV_HEADERS.uncracked
      yield* streamUncrackedRows(fetchBatch)
    }

    return { skippedCount, rows: uncrackedStream() }
  }

  const fetchBatch =
    overrides.fetchCrackedBatch ??
    (await createDefaultCrackedFetcher(db, params, batchSize, filters))

  async function* crackedStream(): AsyncGenerator<string> {
    if (format === 'csv') yield EXPORT_CSV_HEADERS[variant]
    yield* streamCrackedRows(fetchBatch, variant, format)
  }

  return { skippedCount, rows: crackedStream() }
}
