/**
 * Cracker binary registry — engine-aware, MinIO-backed, admin-managed.
 *
 * Hashcat is the default engine throughout: any caller that omits `engine`
 * resolves to `'hashcat'`. Engine values are stored lowercased so that a
 * client sending `'Hashcat'` cannot bypass the composite uniqueness on
 * `(engine, version, platform)`.
 *
 * This module mirrors `resources.ts` for `fileRef` JSONB shape, multipart
 * upload control flow, and presigned-URL behavior. Cracker binaries are
 * NOT project-scoped — they are global registry rows accessible to all
 * agents that opt in via the check-update endpoint.
 */
import { randomUUID } from 'node:crypto';
import { crackerBinaries, KNOWN_ENGINES, type KnownEngineName } from '@hashhive/shared';
import { and, desc, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteFile,
  getPresignedUrl,
  uploadFile,
  uploadPart,
} from '../config/storage.js';
import { db } from '../db/index.js';

const DEFAULT_ENGINE: KnownEngineName = 'hashcat';
const AGENT_DOWNLOAD_TTL_SECONDS = 6 * 3600; // 6 hours
const DEFAULT_PART_SIZE = 64 * 1024 * 1024; // 64 MB
const KNOWN_ENGINE_SET: ReadonlySet<string> = new Set(KNOWN_ENGINES);

/**
 * Defense-in-depth cap on the direct upload path. The route layer
 * already rejects oversized requests via Content-Length and
 * `file.size` checks; this value is enforced again at the service
 * boundary so callers that bypass the route (CLI / future internal
 * tooling) can't OOM the API by handing this function a multi-GB
 * `File`. Mirrors the route-layer constant.
 */
export const CRACKER_DIRECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/**
 * The persisted `fileRef` JSONB has three lifecycle states. Modeling them
 * as a discriminated union forces callers to handle each state instead of
 * everyone reaching into a bag of optionals and writing their own
 * "is this populated yet" check.
 */
export type CrackerFileRef =
  | { state: 'pending' } // freshly-created row, no upload yet
  | {
      state: 'uploading';
      bucket: string;
      key: string;
      contentType: string;
      name: string;
      s3UploadId: string;
      fileSize: number;
    }
  | {
      state: 'completed';
      bucket: string;
      key: string;
      contentType: string;
      size: number;
      name: string;
      uploadedAt: string;
    };

/**
 * Read the JSONB column and project it into the discriminated union.
 * Falls back to `{ state: 'pending' }` for empty objects, null, or any
 * shape that doesn't match a known state.
 */
function readFileRef(rawFileRef: unknown): CrackerFileRef {
  if (!rawFileRef || typeof rawFileRef !== 'object') return { state: 'pending' };
  const ref = rawFileRef as Record<string, unknown>;

  // Completed uploads carry `uploadedAt` and `size` (number). Direct uploads
  // and finished multipart uploads both produce this shape.
  if (
    typeof ref['uploadedAt'] === 'string' &&
    typeof ref['key'] === 'string' &&
    typeof ref['bucket'] === 'string' &&
    typeof ref['size'] === 'number'
  ) {
    return {
      state: 'completed',
      bucket: ref['bucket'],
      key: ref['key'],
      contentType:
        typeof ref['contentType'] === 'string' ? ref['contentType'] : 'application/octet-stream',
      size: ref['size'],
      name: typeof ref['name'] === 'string' ? ref['name'] : '',
      uploadedAt: ref['uploadedAt'],
    };
  }

  // In-progress multipart uploads carry `s3UploadId` and `fileSize`.
  if (
    typeof ref['s3UploadId'] === 'string' &&
    typeof ref['key'] === 'string' &&
    typeof ref['bucket'] === 'string' &&
    typeof ref['fileSize'] === 'number'
  ) {
    return {
      state: 'uploading',
      bucket: ref['bucket'],
      key: ref['key'],
      contentType:
        typeof ref['contentType'] === 'string' ? ref['contentType'] : 'application/octet-stream',
      name: typeof ref['name'] === 'string' ? ref['name'] : '',
      s3UploadId: ref['s3UploadId'],
      fileSize: ref['fileSize'],
    };
  }

  return { state: 'pending' };
}

/**
 * Normalize an engine name to the lowercase form stored in the registry.
 * Hashcat is the default for missing/empty input. Exported so the agent
 * route uses the same logic the service uses (DRY-bound).
 */
export function normalizeEngineName(engine: string | undefined | null): string {
  const trimmed = (engine ?? '').trim().toLowerCase();
  return trimmed === '' ? DEFAULT_ENGINE : trimmed;
}

/** Whether a normalized engine name is one the registry recognizes. */
export function isKnownEngine(engine: string): engine is KnownEngineName {
  return KNOWN_ENGINE_SET.has(engine);
}

/**
 * Detect a postgres unique-constraint violation. Mirrors what postgres-js
 * surfaces as the error `code` on duplicate-key writes; using the typed
 * code instead of substring matching prevents false positives if the
 * driver's error message format changes.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listCrackerBinaries(
  opts: { engine?: string | undefined; includeInactive?: boolean | undefined } = {}
) {
  const conditions = [];
  if (opts.engine !== undefined) {
    conditions.push(eq(crackerBinaries.engine, normalizeEngineName(opts.engine)));
  }
  if (!opts.includeInactive) {
    conditions.push(eq(crackerBinaries.isActive, true));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const query = db.select().from(crackerBinaries);
  return where
    ? query.where(where).orderBy(desc(crackerBinaries.createdAt))
    : query.orderBy(desc(crackerBinaries.createdAt));
}

export async function getCrackerBinaryById(id: number) {
  const [row] = await db.select().from(crackerBinaries).where(eq(crackerBinaries.id, id)).limit(1);
  return row ?? null;
}

/**
 * Thrown by `createCrackerBinary` when version/platform contain only
 * whitespace. The Zod request schemas only enforce `min(1)` against the
 * raw string; an input like `"   "` passes that check but normalizes to
 * `""`, which would silently produce a row that breaks composite
 * uniqueness semantics. The route layer maps this to HTTP 400.
 */
export class CrackerBinaryValidationError extends Error {
  constructor(
    public readonly field: 'version' | 'platform' | 'engine',
    message: string
  ) {
    super(message);
    this.name = 'CrackerBinaryValidationError';
  }
}

export async function createCrackerBinary(data: {
  engine: string;
  version: string;
  platform: string;
}) {
  const engine = normalizeEngineName(data.engine);
  const version = data.version.trim();
  const platform = data.platform.trim();

  if (version.length === 0) {
    throw new CrackerBinaryValidationError('version', 'version cannot be empty after trimming');
  }
  if (platform.length === 0) {
    throw new CrackerBinaryValidationError('platform', 'platform cannot be empty after trimming');
  }

  const [row] = await db
    .insert(crackerBinaries)
    .values({
      engine,
      version,
      platform,
      isActive: true,
    })
    .returning();
  return row ?? null;
}

export async function updateCrackerBinary(id: number, data: { isActive?: boolean | undefined }) {
  const updates: Partial<{ isActive: boolean; updatedAt: Date }> = {
    updatedAt: new Date(),
  };
  if (data.isActive !== undefined) updates.isActive = data.isActive;

  const [row] = await db
    .update(crackerBinaries)
    .set(updates)
    .where(eq(crackerBinaries.id, id))
    .returning();
  return row ?? null;
}

/**
 * Delete a cracker binary record and its stored object.
 *
 * Returns one of three outcomes so callers can surface partial failure to
 * the admin:
 * - `not_found`: no row matched the id.
 * - `deleted`: row removed, and the stored object was either absent
 *   (state `'pending'`), aborted (state `'uploading'`), or deleted (state
 *   `'completed'`).
 * - `storage_failed`: the storage cleanup (abort or delete) errored, so
 *   the DB row was preserved for the admin to retry.
 *
 * The storage operation runs BEFORE the DB delete: if storage fails the
 * row stays put so the admin can retry. This trades "orphaned DB row
 * on retry" for "orphaned S3 object" — the former is recoverable from
 * the dashboard, the latter is not.
 */
export async function deleteCrackerBinary(
  id: number
): Promise<'not_found' | 'deleted' | 'storage_failed'> {
  const row = await getCrackerBinaryById(id);
  if (!row) return 'not_found';

  const fileRef = readFileRef(row.fileRef);

  // Branch on lifecycle state. An in-progress multipart upload needs
  // `abortMultipartUpload` to free MinIO's stored parts; calling
  // `deleteFile` on the key would leave orphaned parts behind because
  // the assembled object doesn't exist yet.
  if (fileRef.state === 'uploading') {
    try {
      await abortMultipartUpload(fileRef.key, fileRef.s3UploadId);
    } catch (err) {
      logger.error(
        { err, crackerBinaryId: id, key: fileRef.key, s3UploadId: fileRef.s3UploadId },
        'Failed to abort cracker S3 multipart upload during delete; leaving DB row in place for retry'
      );
      return 'storage_failed';
    }
  } else if (fileRef.state === 'completed') {
    try {
      await deleteFile(fileRef.key, fileRef.bucket);
    } catch (err) {
      logger.error(
        { err, crackerBinaryId: id, key: fileRef.key, bucket: fileRef.bucket },
        'Failed to delete cracker binary S3 object; leaving DB row in place for retry'
      );
      return 'storage_failed';
    }
  }

  await db.delete(crackerBinaries).where(eq(crackerBinaries.id, id));
  return 'deleted';
}

// ─── Latest-Version Lookup ──────────────────────────────────────────

/**
 * Compares two cracker version strings.
 *
 * **NOT strict semver.** Hashcat tags releases like `6.2.6+125`, where
 * the `+` segment denotes a later beta build. Per strict semver, build
 * metadata after `+` is supposed to be ignored for precedence; here we
 * sort `6.2.6+125` AFTER `6.2.6` so admins uploading hashcat betas
 * advertise correctly. JtR uses suffixes like `1.9.0-jumbo-1`, which
 * we sort lexicographically against bare `1.9.0` (jumbo wins, also a
 * deliberate deviation from semver where `-jumbo-1` would be a
 * pre-release).
 *
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareCrackerVersions(a: string, b: string): number {
  // Find the end of the longest leading numeric prefix matching
  // [0-9]+(\.[0-9]+)*. The first character that doesn't fit becomes the start
  // of the suffix. Implemented without regex because Bun's regex engine on
  // Linux has shown inconsistent greedy-matching behavior on repeating
  // non-capturing groups (which caused parse('6.2.0') to return
  // { nums: [6, 2], rest: '.0' } instead of { nums: [6, 2, 0], rest: '' }).
  const parse = (v: string): { nums: number[]; rest: string } => {
    let lastNumericEnd = 0; // exclusive index — end of the last accepted digit
    let inNumber = false;
    for (let i = 0; i < v.length; i++) {
      const ch = v.charCodeAt(i);
      const isDigit = ch >= 48 && ch <= 57; // '0'..'9'
      const isDot = ch === 46; // '.'
      if (isDigit) {
        inNumber = true;
        lastNumericEnd = i + 1;
      } else if (isDot && inNumber) {
        // Dot only continues the numeric prefix when followed by a digit.
        inNumber = false;
      } else {
        break;
      }
    }
    const numericPart = v.slice(0, lastNumericEnd);
    const rest = v.slice(lastNumericEnd);
    const nums =
      numericPart.length === 0
        ? []
        : numericPart
            .split('.')
            .filter((s) => s.length > 0)
            .map((s) => Number.parseInt(s, 10));
    return { nums, rest };
  };

  const pa = parse(a);
  const pb = parse(b);

  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const an = pa.nums[i] ?? 0;
    const bn = pb.nums[i] ?? 0;
    if (an !== bn) return an - bn;
  }

  // Tiebreak on the suffix; an empty suffix wins (so `6.2.6` is older
  // than `6.2.6+125`). For non-empty suffixes, compare token-by-token
  // splitting on `.`, `-`, `+` so numeric segments sort numerically
  // (`+10` after `+9`) and non-numeric tokens fall back to lex compare.
  if (pa.rest === pb.rest) return 0;
  if (pa.rest === '') return -1;
  if (pb.rest === '') return 1;
  return compareSuffixTokens(pa.rest, pb.rest);
}

function compareSuffixTokens(a: string, b: string): number {
  // Split on the conventional version delimiters. Empty leading tokens
  // (e.g. from a leading `+`) are preserved so `+10` and `+9` compare
  // their numeric tail correctly.
  const tokensA = a.split(/[.+-]/);
  const tokensB = b.split(/[.+-]/);

  const len = Math.max(tokensA.length, tokensB.length);
  for (let i = 0; i < len; i++) {
    const ta = tokensA[i] ?? '';
    const tb = tokensB[i] ?? '';
    if (ta === tb) continue;
    if (ta === '') return -1; // shorter wins -> older
    if (tb === '') return 1;

    const na = /^\d+$/.test(ta) ? Number.parseInt(ta, 10) : NaN;
    const nb = /^\d+$/.test(tb) ? Number.parseInt(tb, 10) : NaN;
    const aIsNum = !Number.isNaN(na);
    const bIsNum = !Number.isNaN(nb);

    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
      continue;
    }
    // Numeric tokens sort before non-numeric ones (`-1` < `-jumbo`).
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return ta < tb ? -1 : 1;
  }
  return 0;
}

export async function getLatestCracker(opts: { engine?: string | undefined; platform: string }) {
  const engine = normalizeEngineName(opts.engine);
  const rows = await db
    .select()
    .from(crackerBinaries)
    .where(
      and(
        eq(crackerBinaries.engine, engine),
        eq(crackerBinaries.platform, opts.platform),
        eq(crackerBinaries.isActive, true)
      )
    );

  if (rows.length === 0) return null;

  // Sort by hashcat-aware version desc, fall back to createdAt desc as
  // final tiebreaker. The argument order is `compare(b, a)` so the
  // largest version sorts first; this is verified in unit tests.
  const sorted = [...rows].sort((a, b) => {
    const cmp = compareCrackerVersions(b.version, a.version);
    if (cmp !== 0) return cmp;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return sorted[0] ?? null;
}

// ─── Presigned Download URLs ────────────────────────────────────────

/**
 * Generate a presigned download URL for a cracker binary. Used by agents
 * to stream the binary directly from MinIO without proxying through the
 * API (avoids tying up an API process for the duration of a multi-MB
 * download).
 *
 * Returns `null` when the row does not exist or has not been uploaded.
 */
export async function getCrackerDownloadUrl(
  id: number
): Promise<{ url: string; expiresIn: number } | null> {
  const row = await getCrackerBinaryById(id);
  if (!row) return null;

  const fileRef = readFileRef(row.fileRef);
  if (fileRef.state !== 'completed') return null;

  const url = await getPresignedUrl(fileRef.key, AGENT_DOWNLOAD_TTL_SECONDS, {
    bucket: fileRef.bucket,
    ...(fileRef.name ? { filename: fileRef.name } : {}),
  });

  return { url, expiresIn: AGENT_DOWNLOAD_TTL_SECONDS };
}

// ─── Direct Upload ──────────────────────────────────────────────────

/**
 * Direct upload — single request, single object write. Used for binaries
 * below the chunked-upload threshold. The route layer enforces a
 * Content-Length cap so this path cannot be abused for very large files.
 */
export async function uploadCrackerFile(
  id: number,
  file: File
): Promise<{ key: string; size: number }> {
  // Defense-in-depth: refuse oversized files before we materialize them
  // in memory. The route layer already does this against Content-Length
  // and `file.size`, but enforcing it here means CLI and other internal
  // callers can't bypass the cap.
  if (file.size > CRACKER_DIRECT_UPLOAD_MAX_BYTES) {
    throw new Error(
      `Direct upload exceeds the ${CRACKER_DIRECT_UPLOAD_MAX_BYTES} byte cap; use the chunked upload path instead`
    );
  }

  const row = await getCrackerBinaryById(id);
  if (!row) throw new Error(`Cracker binary ${id} not found`);

  const key = `crackers/${row.engine}/${row.platform}/${row.version}/${randomUUID()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    await uploadFile(key, buffer, file.type || 'application/octet-stream');
  } catch (err) {
    logger.error({ err, crackerBinaryId: id, key }, 'Direct cracker upload failed');
    throw err;
  }

  let updatedIds: Array<{ id: number }> = [];
  try {
    updatedIds = await db
      .update(crackerBinaries)
      .set({
        fileRef: {
          bucket: env.S3_BUCKET,
          key,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          name: file.name,
          uploadedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(crackerBinaries.id, id))
      .returning({ id: crackerBinaries.id });
  } catch (err) {
    // The S3 object exists but we failed to write the DB pointer to it.
    // Clean up the orphaned object so the next attempt starts fresh.
    logger.error({ err, crackerBinaryId: id, key }, 'DB update after upload failed; cleaning up');
    await deleteFile(key, env.S3_BUCKET).catch((cleanupErr) => {
      logger.error(
        { err: cleanupErr, key, crackerBinaryId: id },
        'Failed to clean up orphan S3 object after DB update failure'
      );
    });
    throw err;
  }

  // The lookup at line ~434 confirmed the row existed, but another admin
  // could have deleted it in the window between the lookup and this
  // update. A zero-row update is success at the DB level but means the
  // freshly-uploaded S3 object has no row pointing at it — clean it up
  // and surface the race as an error rather than silently leaking.
  if (updatedIds.length === 0) {
    logger.error(
      { crackerBinaryId: id, key },
      'Cracker binary row vanished during upload; cleaning up orphan S3 object'
    );
    await deleteFile(key, env.S3_BUCKET).catch((cleanupErr) => {
      logger.error(
        { err: cleanupErr, key, crackerBinaryId: id },
        'Failed to clean up orphan S3 object after concurrent delete'
      );
    });
    throw new Error(`Cracker binary ${id} disappeared during upload`);
  }

  return { key, size: file.size };
}

// ─── Chunked (S3 Multipart) Upload ──────────────────────────────────

export async function initiateCrackerChunkedUpload(data: {
  id: number;
  fileSize: number;
  contentType?: string | undefined;
  fileName?: string | undefined;
}): Promise<{ uploadId: string; partSize: number; key: string }> {
  const row = await getCrackerBinaryById(data.id);
  if (!row) throw new Error(`Cracker binary ${data.id} not found`);

  // Reject re-initiation on a row that is already mid-upload — concurrent
  // initiates would overwrite the first session's `fileRef.s3UploadId`,
  // and subsequent part uploads from the first session would land on the
  // second session's object (silent data corruption on completion).
  const existing = readFileRef(row.fileRef);
  if (existing.state === 'uploading') {
    throw new Error(
      `Cracker binary ${data.id} already has an in-progress upload (uploadId=${existing.s3UploadId}); abort it first`
    );
  }

  const fileName = data.fileName ?? `${row.engine}-${row.version}-${row.platform}`;
  const key = `crackers/${row.engine}/${row.platform}/${row.version}/${randomUUID()}-${fileName}`;
  const ct = data.contentType ?? 'application/octet-stream';

  let s3UploadId: string;
  try {
    s3UploadId = await createMultipartUpload(key, ct);
  } catch (err) {
    logger.error({ err, crackerBinaryId: data.id }, 'S3 multipart initiation failed');
    throw err;
  }

  await db
    .update(crackerBinaries)
    .set({
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: ct,
        name: fileName,
        s3UploadId,
        fileSize: data.fileSize,
      },
      updatedAt: new Date(),
    })
    .where(eq(crackerBinaries.id, data.id));

  return { uploadId: s3UploadId, partSize: DEFAULT_PART_SIZE, key };
}

/**
 * Upload one part of an in-progress multipart upload.
 *
 * Validates that the caller's `s3UploadId` matches the row's stored
 * upload session — otherwise a stale or attacker-supplied uploadId
 * could mutate parts on a different session's key. Mismatches throw
 * with a typed signal the route layer surfaces as 409.
 */
export async function uploadCrackerChunkPart(
  id: number,
  s3UploadId: string,
  partNumber: number,
  body: Uint8Array
): Promise<{ etag: string }> {
  const row = await getCrackerBinaryById(id);
  if (!row) throw new Error(`Cracker binary ${id} not found`);

  const fileRef = readFileRef(row.fileRef);
  if (fileRef.state !== 'uploading') {
    throw new Error(`Cracker binary ${id} has no in-progress upload`);
  }
  if (fileRef.s3UploadId !== s3UploadId) {
    throw new CrackerUploadIdMismatchError(id, s3UploadId, fileRef.s3UploadId);
  }

  const etag = await uploadPart(fileRef.key, s3UploadId, partNumber, body);

  await db.update(crackerBinaries).set({ updatedAt: new Date() }).where(eq(crackerBinaries.id, id));

  return { etag };
}

export async function completeCrackerChunkedUpload(
  id: number,
  s3UploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>
): Promise<{ id: number }> {
  const row = await getCrackerBinaryById(id);
  if (!row) throw new Error(`Cracker binary ${id} not found`);

  const fileRef = readFileRef(row.fileRef);
  if (fileRef.state !== 'uploading') {
    throw new Error(`Cracker binary ${id} has no in-progress upload to complete`);
  }
  if (fileRef.s3UploadId !== s3UploadId) {
    throw new CrackerUploadIdMismatchError(id, s3UploadId, fileRef.s3UploadId);
  }

  // Defensive: fileSize must be present for the row to render correctly
  // in the dashboard. The discriminated union guarantees this at compile
  // time; the explicit check guards against a malformed JSONB written by
  // a future code path or an external mutation.
  if (!Number.isFinite(fileRef.fileSize) || fileRef.fileSize <= 0) {
    throw new Error(`Cracker binary ${id} has invalid fileSize on its in-progress upload`);
  }

  await completeMultipartUpload(fileRef.key, s3UploadId, parts);

  const updatedFileRef = {
    bucket: fileRef.bucket,
    key: fileRef.key,
    contentType: fileRef.contentType,
    size: fileRef.fileSize,
    name: fileRef.name,
    uploadedAt: new Date().toISOString(),
  };

  await db
    .update(crackerBinaries)
    .set({ fileRef: updatedFileRef, updatedAt: new Date() })
    .where(eq(crackerBinaries.id, id));

  logger.info({ crackerBinaryId: id }, 'Cracker chunked upload completed');
  return { id };
}

/**
 * Abort an in-progress multipart upload and reset the row to a clean
 * pre-upload state. Both the S3 abort AND the DB reset are attempted —
 * if S3 fails (the object may have already been garbage-collected by
 * the lifecycle policy), the DB is still cleared so a future upload
 * can succeed without manual intervention.
 */
export async function abortCrackerChunkedUpload(id: number, s3UploadId: string): Promise<void> {
  const row = await getCrackerBinaryById(id);
  if (!row) return;

  const fileRef = readFileRef(row.fileRef);
  if (fileRef.state !== 'uploading') return; // nothing to abort

  if (fileRef.s3UploadId !== s3UploadId) {
    // Stale uploadId from a client that didn't refresh its state —
    // don't abort the wrong session.
    throw new CrackerUploadIdMismatchError(id, s3UploadId, fileRef.s3UploadId);
  }

  await abortMultipartUpload(fileRef.key, s3UploadId).catch((err) => {
    logger.warn(
      { err, s3UploadId, crackerBinaryId: id },
      'Failed to abort cracker S3 multipart upload; clearing DB anyway'
    );
  });

  // Always clear the DB pointer so the next upload starts clean.
  await db
    .update(crackerBinaries)
    .set({ fileRef: {}, updatedAt: new Date() })
    .where(eq(crackerBinaries.id, id));

  logger.info({ crackerBinaryId: id, s3UploadId }, 'Cracker chunked upload aborted');
}

/**
 * Thrown by the chunked-upload service functions when the caller's
 * `s3UploadId` does not match the row's stored upload session. The
 * route layer maps this to HTTP 409.
 */
export class CrackerUploadIdMismatchError extends Error {
  constructor(
    public readonly crackerBinaryId: number,
    public readonly attemptedUploadId: string,
    public readonly storedUploadId: string
  ) {
    super(
      `Upload session mismatch on cracker binary ${crackerBinaryId}: ` +
        `attempted=${attemptedUploadId} stored=${storedUploadId}`
    );
    this.name = 'CrackerUploadIdMismatchError';
  }
}
