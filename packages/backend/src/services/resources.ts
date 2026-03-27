import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { hashItems, hashLists, hashTypes, maskLists, ruleLists, wordLists } from '@hashhive/shared';
import { and, count, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  getPresignedUrl,
  listParts,
  uploadFile,
  uploadPart,
} from '../config/storage.js';
import { db } from '../db/index.js';

// ─── Hash Types ──────────────────────────────────────────────────────

export async function listHashTypes() {
  return db.select().from(hashTypes).orderBy(hashTypes.hashcatMode);
}

export async function getHashTypeById(id: number) {
  const [ht] = await db.select().from(hashTypes).where(eq(hashTypes.id, id)).limit(1);
  return ht ?? null;
}

// ─── Hash Lists ─────────────────────────────────────────────────────

export async function listHashLists(projectId: number) {
  return db
    .select()
    .from(hashLists)
    .where(eq(hashLists.projectId, projectId))
    .orderBy(desc(hashLists.createdAt));
}

export async function getHashListById(id: number, projectId: number) {
  const [hl] = await db
    .select()
    .from(hashLists)
    .where(and(eq(hashLists.id, id), eq(hashLists.projectId, projectId)))
    .limit(1);
  return hl ?? null;
}

export async function createHashList(data: {
  projectId: number;
  name: string;
  hashTypeId?: number | undefined;
  source?: string | undefined;
}) {
  const [hl] = await db
    .insert(hashLists)
    .values({
      projectId: data.projectId,
      name: data.name,
      hashTypeId: data.hashTypeId ?? null,
      source: data.source ?? 'upload',
      status: 'uploading',
    })
    .returning();

  return hl ?? null;
}

export async function uploadHashListFile(
  hashListId: number,
  projectId: number,
  file: File
): Promise<{ key: string; size: number }> {
  const hl = await getHashListById(hashListId, projectId);
  if (!hl) {
    throw new Error(`Hash list ${hashListId} not found`);
  }

  const ext = extname(file.name);
  const key = `${hl.projectId}/hash-lists/${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadFile(key, buffer, file.type || 'application/octet-stream');

  await db
    .update(hashLists)
    .set({
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        name: file.name,
        uploadedAt: new Date().toISOString(),
      },
      status: 'uploaded',
      updatedAt: new Date(),
    })
    .where(eq(hashLists.id, hashListId));

  return { key, size: file.size };
}

export async function importHashList(hashListId: number, projectId: number) {
  const hl = await getHashListById(hashListId, projectId);
  if (!hl) {
    return null;
  }

  // Check queue availability before marking as processing
  const { getQueueManager } = await import('../queue/context.js');
  const { QUEUE_NAMES } = await import('../config/queue.js');
  const qm = getQueueManager();
  if (!qm) {
    return { error: 'Queue unavailable — cannot process hash list' };
  }
  const health = await qm.getHealth();
  if (health.status === 'disconnected') {
    return { error: 'Queue unavailable — cannot process hash list' };
  }

  // Mark as processing
  await db
    .update(hashLists)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(hashLists.id, hashListId));

  // Enqueue async parsing job into the hash-list-parsing job queue
  const enqueued = await qm.enqueue(QUEUE_NAMES.HASH_LIST_PARSING, {
    hashListId,
    projectId: hl.projectId,
  });

  if (!enqueued) {
    // Revert status since the job was not enqueued
    await db
      .update(hashLists)
      .set({ status: 'uploaded', updatedAt: new Date() })
      .where(eq(hashLists.id, hashListId));
    return { error: 'Failed to enqueue hash list parsing job' };
  }

  return { status: 'processing' as const, queued: true };
}

export async function getHashItems(
  hashListId: number,
  projectId: number,
  opts: {
    limit?: number | undefined;
    offset?: number | undefined;
    status?: 'all' | 'cracked' | 'uncracked' | undefined;
    search?: string | undefined;
  }
) {
  // Verify hash list belongs to project (IDOR prevention)
  const hl = await getHashListById(hashListId, projectId);
  if (!hl) return null;

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions: SQL[] = [eq(hashItems.hashListId, hashListId)];

  if (opts.status === 'cracked') {
    conditions.push(isNotNull(hashItems.crackedAt));
  } else if (opts.status === 'uncracked') {
    conditions.push(sql`${hashItems.crackedAt} IS NULL`);
  }

  if (opts.search) {
    const escaped = escapeLike(opts.search);
    conditions.push(sql`${hashItems.hashValue} ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
  }

  const whereClause = and(...conditions);

  const [items, countResult] = await Promise.all([
    db
      .select()
      .from(hashItems)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(hashItems.id),
    db.select({ count: sql<number>`count(*)` }).from(hashItems).where(whereClause),
  ]);

  return { items, total: Number(countResult[0]?.count ?? 0), limit, offset };
}

/**
 * Escape LIKE/ILIKE metacharacters to prevent wildcard injection.
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

// ─── Hash List Statistics ────────────────────────────────────────────

/**
 * Computes live cracked/total/remaining counts for a hash list.
 * Uses a single COUNT + FILTER query (fast with composite index).
 */
export async function getHashListStats(hashListId: number): Promise<{
  total: number;
  cracked: number;
  remaining: number;
}> {
  const [stats] = await db
    .select({
      total: count(),
      cracked: sql<number>`count(*) FILTER (WHERE ${hashItems.crackedAt} IS NOT NULL)`,
    })
    .from(hashItems)
    .where(eq(hashItems.hashListId, hashListId));

  const total = Number(stats?.total ?? 0);
  const cracked = Number(stats?.cracked ?? 0);
  return { total, cracked, remaining: total - cracked };
}

// ─── Generic Resource Lists (wordlists, rulelists, masklists) ───────

export type ResourceTable = typeof wordLists | typeof ruleLists | typeof maskLists;

export async function listResources(table: ResourceTable, projectId: number) {
  return db
    .select()
    .from(table)
    .where(eq(table.projectId, projectId))
    .orderBy(desc(table.createdAt));
}

export async function getResourceById(table: ResourceTable, id: number, projectId: number) {
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

export async function createResource(
  table: ResourceTable,
  data: { projectId: number; name: string }
) {
  const [row] = await db.insert(table).values(data).returning();
  return row ?? null;
}

export async function uploadResourceFile(
  table: ResourceTable,
  resourceId: number,
  projectId: number,
  prefix: string,
  file: File
) {
  const resource = await getResourceById(table, resourceId, projectId);
  if (!resource) {
    throw new Error(`Resource ${resourceId} not found in ${prefix}`);
  }

  const ext = extname(file.name);
  const key = `${resource.projectId}/${prefix}/${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadFile(key, buffer, file.type || 'application/octet-stream');

  await db
    .update(table)
    .set({
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        name: file.name,
        uploadedAt: new Date().toISOString(),
      },
      fileSize: file.size,
      status: 'ready',
      updatedAt: new Date(),
    })
    .where(eq(table.id, resourceId));

  return { key, size: file.size };
}

// ─── Presigned URLs ─────────────────────────────────────────────────

export async function getResourcePresignedUrl(fileRef: {
  bucket: string;
  key: string;
  name?: string;
}): Promise<string> {
  return getPresignedUrl(fileRef.key, 3600, {
    bucket: fileRef.bucket,
    ...(fileRef.name ? { filename: fileRef.name } : {}),
  });
}

/**
 * Generate a presigned download URL with extended expiry for large files.
 * Used by agents to download resources directly from S3.
 */
export async function getAgentDownloadUrl(
  resourceType: string,
  resourceId: number,
  projectId: number
): Promise<{ url: string; expiresIn: number } | null> {
  const tableMap: Record<string, ResourceTable | typeof hashLists> = {
    'hash-lists': hashLists,
    wordlists: wordLists,
    rulelists: ruleLists,
    masklists: maskLists,
  };

  const table = tableMap[resourceType];
  if (!table) return null;

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1);
  if (!row) return null;

  const fileRef = row.fileRef as { bucket?: string; key?: string; name?: string } | null;
  if (!fileRef?.bucket || !fileRef?.key) return null;

  const expiresIn = 6 * 3600; // 6 hours for large files
  const url = await getPresignedUrl(fileRef.key, expiresIn, {
    bucket: fileRef.bucket,
    ...(fileRef.name ? { filename: fileRef.name } : {}),
  });

  return { url, expiresIn };
}

// ─── Chunked Upload (S3 Multipart) ─────────────────────────────────

const RESOURCE_TYPE_TABLE: Record<string, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
};

const DEFAULT_PART_SIZE = 64 * 1024 * 1024; // 64 MB

export async function initiateChunkedUpload(data: {
  resourceType: string;
  name: string;
  fileSize: number;
  projectId: number;
  contentType?: string | undefined;
}): Promise<{
  uploadId: string;
  resourceId: number;
  partSize: number;
  key: string;
}> {
  const { resourceType, name, fileSize, projectId, contentType } = data;

  // Hash lists use the hashLists table with different create logic
  const isHashList = resourceType === 'hash-lists';
  const table: ResourceTable | typeof hashLists | undefined = isHashList
    ? hashLists
    : RESOURCE_TYPE_TABLE[resourceType];

  if (!table) {
    throw new Error(`Unknown resource type: ${resourceType}`);
  }

  // Create DB record
  let resourceId: number;
  if (isHashList) {
    const hl = await createHashList({ projectId, name, source: 'upload' });
    if (!hl) throw new Error('Failed to create hash list');
    resourceId = hl.id;
  } else {
    const row = await createResource(table as ResourceTable, { projectId, name });
    if (!row) throw new Error(`Failed to create ${resourceType}`);
    resourceId = row.id;
  }

  // Generate S3 key
  const prefix = isHashList ? 'hash-lists' : resourceType;
  const key = `${projectId}/${prefix}/${randomUUID()}`;
  const ct = contentType ?? 'application/octet-stream';

  // Initiate S3 multipart upload — clean up orphan DB record on failure
  let s3UploadId: string;
  try {
    s3UploadId = await createMultipartUpload(key, ct);
  } catch (err) {
    logger.error(
      { err, resourceId, resourceType },
      'S3 multipart initiation failed, removing orphan DB record'
    );
    await db.delete(table).where(eq(table.id, resourceId));
    throw err;
  }

  await db
    .update(table)
    .set({
      status: 'uploading',
      fileRef: {
        bucket: env.S3_BUCKET,
        key,
        contentType: ct,
        name,
        s3UploadId,
        fileSize,
      },
      updatedAt: new Date(),
    })
    .where(eq(table.id, resourceId));

  logger.info({ resourceId, resourceType, s3UploadId, fileSize }, 'Chunked upload initiated');

  return { uploadId: s3UploadId, resourceId, partSize: DEFAULT_PART_SIZE, key };
}

export async function uploadChunkPart(
  s3UploadId: string,
  partNumber: number,
  body: Uint8Array,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<{ etag: string }> {
  // Look up the S3 key from the resource's fileRef
  const isHashList = resourceType === 'hash-lists';
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType];
  if (!table) throw new Error(`Unknown resource type: ${resourceType}`);

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`Resource ${resourceId} not found`);

  const fileRef = row.fileRef as { key?: string } | null;
  if (!fileRef?.key) throw new Error('Resource has no file reference');

  const etag = await uploadPart(fileRef.key, s3UploadId, partNumber, body);

  // Update timestamp
  await db.update(table).set({ updatedAt: new Date() }).where(eq(table.id, resourceId));

  return { etag };
}

export async function completeChunkedUpload(
  s3UploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<{ resourceId: number }> {
  const isHashList = resourceType === 'hash-lists';
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType];
  if (!table) throw new Error(`Unknown resource type: ${resourceType}`);

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`Resource ${resourceId} not found`);

  const fileRef = row.fileRef as {
    key?: string;
    bucket?: string;
    contentType?: string;
    name?: string;
    fileSize?: number;
  } | null;
  if (!fileRef?.key) throw new Error('Resource has no file reference');

  // Complete S3 multipart upload
  await completeMultipartUpload(fileRef.key, s3UploadId, parts);

  // Update resource status to ready
  const updatedFileRef = {
    bucket: fileRef.bucket ?? env.S3_BUCKET,
    key: fileRef.key,
    contentType: fileRef.contentType ?? 'application/octet-stream',
    size: fileRef.fileSize,
    name: fileRef.name,
    uploadedAt: new Date().toISOString(),
  };

  await db
    .update(table)
    .set({
      status: isHashList ? 'uploaded' : 'ready',
      fileRef: updatedFileRef,
      ...(isHashList ? {} : { fileSize: fileRef.fileSize }),
      updatedAt: new Date(),
    })
    .where(eq(table.id, resourceId));

  logger.info({ resourceId, resourceType }, 'Chunked upload completed');

  return { resourceId };
}

export async function abortChunkedUpload(
  s3UploadId: string,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<void> {
  const isHashList = resourceType === 'hash-lists';
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType];
  if (!table) throw new Error(`Unknown resource type: ${resourceType}`);

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1);
  if (!row) return;

  const fileRef = row.fileRef as { key?: string } | null;
  if (fileRef?.key) {
    await abortMultipartUpload(fileRef.key, s3UploadId).catch((err) => {
      logger.warn({ err, s3UploadId }, 'Failed to abort S3 multipart upload');
    });
  }

  await db
    .update(table)
    .set({ status: 'error', updatedAt: new Date() })
    .where(eq(table.id, resourceId));

  logger.info({ resourceId, resourceType, s3UploadId }, 'Chunked upload aborted');
}

export async function getChunkedUploadStatus(
  s3UploadId: string,
  resourceId: number,
  resourceType: string,
  projectId: number
): Promise<{
  status: string;
  completedParts: Array<{ partNumber: number; etag: string; size: number }>;
} | null> {
  const isHashList = resourceType === 'hash-lists';
  const table = isHashList ? hashLists : RESOURCE_TYPE_TABLE[resourceType];
  if (!table) return null;

  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.projectId, projectId)))
    .limit(1);
  if (!row) return null;

  const fileRef = row.fileRef as { key?: string } | null;
  if (!fileRef?.key) return null;

  const completedParts = await listParts(fileRef.key, s3UploadId);

  return { status: row.status, completedParts };
}
