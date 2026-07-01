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

import { attacks, campaigns, hashItems, hashLists, hashTypes } from '@hashhive/shared'
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, not, or } from 'drizzle-orm'

import type { db as _db } from '../../db/index.js'

type Db = typeof _db

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
  if (format === 'hashcat-potfile') {
    // KTD5: hashValue already contains `hash:salt` for salted modes;
    // export is always `hashValue:plaintext` — no reconstruction needed.
    return `${row.hashValue}:${row.plaintext ?? ''}`
  }
  // john-potfile — tag is guaranteed non-null because isEmittable passed
  const tag = JOHN_FORMAT_TAGS[row.hashcatMode!]!
  return `${tag}${row.hashValue}:${row.plaintext ?? ''}`
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

export type ExportScopeParams = HashListScopeParams | CampaignScopeParams | ProjectScopeParams

export type ExportServiceParams = ExportScopeParams & {
  variant: ExportVariant
  format: ExportFormat
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

function buildCrackedBaseConditions(params: ExportScopeParams) {
  const base = [eq(hashLists.projectId, params.projectId), isNotNull(hashItems.crackedAt)]
  if (params.scope === 'hash-list') {
    return [...base, eq(hashItems.hashListId, params.hashListId)]
  }
  if (params.scope === 'campaign') {
    return [...base, eq(hashItems.campaignId, params.campaignId)]
  }
  return base
}

function createDefaultCrackedFetcher(
  db: Db,
  params: ExportScopeParams,
  batchSize: number
): CrackedBatchFetcher {
  const baseConditions = buildCrackedBaseConditions(params)

  return async (cursor) => {
    const conditions = [
      ...baseConditions,
      ...(cursor != null
        ? [
            or(
              lt(hashItems.crackedAt, cursor.crackedAt),
              and(eq(hashItems.crackedAt, cursor.crackedAt), lt(hashItems.id, cursor.id))
            )!,
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

function createDefaultUncrackedFetcher(
  db: Db,
  params: ExportScopeParams,
  batchSize: number
): UncrackedBatchFetcher {
  return async (cursor) => {
    const baseConds = [
      eq(hashLists.projectId, params.projectId),
      isNull(hashItems.crackedAt),
      ...(cursor != null ? [lt(hashItems.id, cursor.id)] : []),
    ]

    if (params.scope === 'hash-list') {
      return db
        .select({ id: hashItems.id, hashValue: hashItems.hashValue })
        .from(hashItems)
        .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
        .where(and(...baseConds, eq(hashItems.hashListId, params.hashListId)))
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
          and(eq(campaigns.id, params.campaignId), eq(campaigns.hashListId, hashItems.hashListId))!
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
  format: ExportFormat
): SkippedCounter {
  return async () => {
    if (format === 'csv') return 0

    // Rows are skipped when the list has no hash type (hashcatMode is null)
    // or, for john-potfile, when the mode is not in the supported tag map.
    const modeFilter =
      format === 'hashcat-potfile'
        ? isNull(hashTypes.id)
        : or(isNull(hashTypes.id), not(inArray(hashTypes.hashcatMode, [...JOHN_MAPPED_MODES])))!

    const conditions = [...buildCrackedBaseConditions(params), modeFilter]

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
  const { variant, format } = params

  // Skip-counting only applies to potfile formats — CSV emits every row regardless
  // of hash type. Uncracked rows can never produce a potfile (schema rejects it).
  const needsSkipCount = variant !== 'uncracked' && format !== 'csv'
  const skippedCount = needsSkipCount
    ? await (overrides.countSkipped ?? createDefaultSkippedCounter(db, params, format))()
    : 0

  if (variant === 'uncracked') {
    const fetchBatch =
      overrides.fetchUncrackedBatch ?? createDefaultUncrackedFetcher(db, params, batchSize)

    async function* uncrackedStream(): AsyncGenerator<string> {
      yield EXPORT_CSV_HEADERS.uncracked
      yield* streamUncrackedRows(fetchBatch)
    }

    return { skippedCount, rows: uncrackedStream() }
  }

  const fetchBatch =
    overrides.fetchCrackedBatch ?? createDefaultCrackedFetcher(db, params, batchSize)

  async function* crackedStream(): AsyncGenerator<string> {
    if (format === 'csv') yield EXPORT_CSV_HEADERS[variant]
    yield* streamCrackedRows(fetchBatch, variant, format)
  }

  return { skippedCount, rows: crackedStream() }
}
