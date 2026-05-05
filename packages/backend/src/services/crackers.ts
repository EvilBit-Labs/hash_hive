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
import { crackerBinaries } from '@hashhive/shared';
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

const DEFAULT_ENGINE = 'hashcat';
const AGENT_DOWNLOAD_TTL_SECONDS = 6 * 3600; // 6 hours
const DEFAULT_PART_SIZE = 64 * 1024 * 1024; // 64 MB

interface CrackerFileRef {
  bucket?: string;
  key?: string;
  contentType?: string;
  size?: number;
  name?: string;
  s3UploadId?: string;
  fileSize?: number;
  uploadedAt?: string;
}

function normalizeEngine(engine: string | undefined | null): string {
  return (engine ?? DEFAULT_ENGINE).trim().toLowerCase();
}

// ─── CRUD ───────────────────────────────────────────────────────────

export async function listCrackerBinaries(
  opts: { engine?: string | undefined; includeInactive?: boolean | undefined } = {}
) {
  const conditions = [];
  if (opts.engine !== undefined) {
    conditions.push(eq(crackerBinaries.engine, normalizeEngine(opts.engine)));
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

export async function createCrackerBinary(data: {
  engine: string;
  version: string;
  platform: string;
}) {
  const [row] = await db
    .insert(crackerBinaries)
    .values({
      engine: normalizeEngine(data.engine),
      version: data.version.trim(),
      platform: data.platform.trim(),
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

export async function deleteCrackerBinary(id: number): Promise<boolean> {
  const row = await getCrackerBinaryById(id);
  if (!row) return false;

  const fileRef = row.fileRef as CrackerFileRef | null;
  if (fileRef?.key) {
    await deleteFile(fileRef.key, fileRef.bucket).catch((err) => {
      logger.warn(
        { err, crackerBinaryId: id, key: fileRef.key },
        'Failed to delete cracker binary S3 object'
      );
    });
  }

  await db.delete(crackerBinaries).where(eq(crackerBinaries.id, id));
  return true;
}

// ─── Latest-Version Lookup ──────────────────────────────────────────

/**
 * Compares two cracker version strings. Semver-aware where possible, with
 * a stable lexicographic fallback for vendor-suffixed versions like
 * `1.9.0-jumbo-1` so callers always get a deterministic ordering.
 *
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
export function compareCrackerVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; rest: string } => {
    const match = v.match(/^(\d+(?:\.\d+)*)([\s\S]*)$/);
    if (!match) return { nums: [], rest: v };
    const numericPart = match[1] ?? '';
    const nums = numericPart.split('.').map((n) => Number.parseInt(n, 10));
    return { nums, rest: match[2] ?? '' };
  };

  const pa = parse(a);
  const pb = parse(b);

  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const an = pa.nums[i] ?? 0;
    const bn = pb.nums[i] ?? 0;
    if (an !== bn) return an - bn;
  }

  // Tiebreak on the suffix lexicographically; an empty suffix wins
  // (i.e. `6.2.6` is "older than" `6.2.6+125` so `+125` sorts later).
  if (pa.rest === pb.rest) return 0;
  if (pa.rest === '') return -1;
  if (pb.rest === '') return 1;
  return pa.rest < pb.rest ? -1 : 1;
}

export async function getLatestCracker(opts: { engine?: string | undefined; platform: string }) {
  const engine = normalizeEngine(opts.engine);
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

  // Sort by semver desc, fall back to createdAt desc as final tiebreaker.
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
 * API.
 */
export async function getCrackerDownloadUrl(
  id: number
): Promise<{ url: string; expiresIn: number } | null> {
  const row = await getCrackerBinaryById(id);
  if (!row) return null;

  const fileRef = row.fileRef as CrackerFileRef | null;
  if (!fileRef?.bucket || !fileRef?.key) return null;

  const url = await getPresignedUrl(fileRef.key, AGENT_DOWNLOAD_TTL_SECONDS, {
    bucket: fileRef.bucket,
    ...(fileRef.name ? { filename: fileRef.name } : {}),
  });

  return { url, expiresIn: AGENT_DOWNLOAD_TTL_SECONDS };
}

// ─── Direct Upload ──────────────────────────────────────────────────

export async function uploadCrackerFile(
  id: number,
  file: File
): Promise<{ key: string; size: number }> {
  const row = await getCrackerBinaryById(id);
  if (!row) throw new Error(`Cracker binary ${id} not found`);

  const key = `crackers/${row.engine}/${row.platform}/${row.version}/${randomUUID()}-${file.name}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadFile(key, buffer, file.type || 'application/octet-stream');

  await db
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
    .where(eq(crackerBinaries.id, id));

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

export async function uploadCrackerChunkPart(
  id: number,
  s3UploadId: string,
  partNumber: number,
  body: Uint8Array
): Promise<{ etag: string }> {
  const row = await getCrackerBinaryById(id);
  if (!row) throw new Error(`Cracker binary ${id} not found`);

  const fileRef = row.fileRef as CrackerFileRef | null;
  if (!fileRef?.key) throw new Error('Cracker binary has no file reference');

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

  const fileRef = row.fileRef as CrackerFileRef | null;
  if (!fileRef?.key) throw new Error('Cracker binary has no file reference');

  await completeMultipartUpload(fileRef.key, s3UploadId, parts);

  const updatedFileRef = {
    bucket: fileRef.bucket ?? env.S3_BUCKET,
    key: fileRef.key,
    contentType: fileRef.contentType ?? 'application/octet-stream',
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

export async function abortCrackerChunkedUpload(id: number, s3UploadId: string): Promise<void> {
  const row = await getCrackerBinaryById(id);
  if (!row) return;

  const fileRef = row.fileRef as CrackerFileRef | null;
  if (fileRef?.key) {
    await abortMultipartUpload(fileRef.key, s3UploadId).catch((err) => {
      logger.warn({ err, s3UploadId }, 'Failed to abort cracker S3 multipart upload');
    });
  }

  logger.info({ crackerBinaryId: id, s3UploadId }, 'Cracker chunked upload aborted');
}
