/**
 * Chunked-upload compression worker service (issue #108 U4).
 *
 * Chunked/multipart uploads stream parts straight to S3 without the server
 * ever buffering the whole file -- that's the entire point of the chunked
 * path, which exists to support files too large to fit in memory (100 GB+).
 * Direct uploads (U3, `compression.ts`) can gzip a buffer synchronously
 * because they're capped at `MAX_DIRECT_UPLOAD_BYTES`; chunked uploads have
 * no such cap, so compression AND the authoritative raw-file checksum are
 * captured together in ONE background streaming pass, after the object has
 * already landed in storage.
 *
 * ── Idempotency ──────────────────────────────────────────────────────
 *
 * `file_checksum` is only ever written by this worker for a normal
 * (non-restore) chunked-upload completion -- `completeChunkedUpload` no
 * longer computes it inline for that case (that was a wasteful second full
 * download of a potentially 100GB object just uploaded). A non-null
 * `file_checksum` on entry therefore means a prior run of this worker
 * already completed successfully for this resource; re-running is a pure
 * no-op. This reuses an existing column rather than adding a new
 * "processed" marker column -- the reclaimed-shell restore path (which
 * verifies+sets `file_checksum` synchronously and is never enqueued here,
 * see `completeChunkedUpload`) is the only other writer, so there is no
 * ambiguity about which path set it.
 *
 * ── Never buffering the whole object ─────────────────────────────────
 *
 * The raw object is downloaded ONCE and piped through a Node `zlib` gzip
 * Transform stream; the SHA-256 hash is updated per raw chunk as it arrives
 * (before compression), so the checksum and the compressed bytes both come
 * out of a single streaming pass. The gzip output is uploaded via S3
 * multipart, buffering only up to `MULTIPART_MIN_PART_BYTES` (the S3
 * minimum non-final part size) of compressed bytes at a time before
 * flushing a part -- never the full compressed object, let alone the full
 * raw one. Only once the whole pass completes do we know the total
 * compressed size and can decide whether compression actually helped.
 */
import type { ResourceCompressionEncoding } from '@hashhive/shared'

import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createGzip } from 'node:zlib'

import { logger } from '../../config/logger.js'
import {
  abortMultipartUpload as abortMultipartUploadDefault,
  completeMultipartUpload as completeMultipartUploadDefault,
  createMultipartUpload as createMultipartUploadDefault,
  deleteFile as deleteFileDefault,
  downloadFile as downloadFileDefault,
  uploadPart as uploadPartDefault,
} from '../../config/storage.js'
import { db } from '../../db/index.js'
import { RESOURCE_TABLE_BY_TYPE } from './tables.js'

export type CompressibleResourceType = 'wordlist' | 'rulelist' | 'masklist'

/** S3's minimum part size for every part except the last one. */
const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024

export type CompressionOutcome = 'compressed' | 'kept-raw' | 'already-processed' | 'no-file-ref'

export interface CompressionResult {
  status: CompressionOutcome
  rawBytes: number
  compressedBytes: number | null
  checksum: string | null
}

/** Injectable storage boundary so tests can exercise this without mocking a module. */
export interface CompressionStorageDeps {
  downloadFile: typeof downloadFileDefault
  deleteFile: typeof deleteFileDefault
  createMultipartUpload: typeof createMultipartUploadDefault
  uploadPart: typeof uploadPartDefault
  completeMultipartUpload: typeof completeMultipartUploadDefault
  abortMultipartUpload: typeof abortMultipartUploadDefault
}

interface ResourceFileRef {
  key?: string
  bucket?: string
  contentType?: string
  [k: string]: unknown
}

/**
 * Compress the just-completed chunked-upload object for `resourceId` (a
 * word/rule/mask list), capturing the authoritative raw-file SHA-256
 * checksum in the same streaming pass. Idempotent: a resource whose
 * `file_checksum` is already set is treated as already processed and
 * returns immediately without touching storage.
 *
 * On any failure partway through, the multipart upload (if one was
 * started) is aborted and the error is rethrown -- the resource row is
 * never touched until the pass fully succeeds, so a failure always leaves
 * the resource served from its original raw object, `compression_encoding`
 * unchanged, and retriable (BullMQ's default retry/backoff applies to the
 * enclosing job).
 */
export async function compressChunkedResourceObject(
  resourceType: CompressibleResourceType,
  resourceId: number,
  deps: Partial<CompressionStorageDeps> = {}
): Promise<CompressionResult> {
  const table = RESOURCE_TABLE_BY_TYPE[resourceType]
  const download = deps.downloadFile ?? downloadFileDefault
  const del = deps.deleteFile ?? deleteFileDefault
  const createMPU = deps.createMultipartUpload ?? createMultipartUploadDefault
  const uploadPartFn = deps.uploadPart ?? uploadPartDefault
  const completeMPU = deps.completeMultipartUpload ?? completeMultipartUploadDefault
  const abortMPU = deps.abortMultipartUpload ?? abortMultipartUploadDefault

  const [row] = await db
    .select({ fileRef: table.fileRef, fileChecksum: table.fileChecksum })
    .from(table)
    .where(eq(table.id, resourceId))
    .limit(1)
  if (!row) {
    throw new Error(`${resourceType} ${resourceId} not found`)
  }

  if (row.fileChecksum !== null) {
    logger.debug(
      { resourceType, resourceId },
      'resource-compression: resource already processed, skipping'
    )
    return {
      status: 'already-processed',
      rawBytes: 0,
      compressedBytes: null,
      checksum: row.fileChecksum,
    }
  }

  const fileRef = row.fileRef as ResourceFileRef | null
  if (!fileRef?.key) {
    logger.warn({ resourceType, resourceId }, 'resource-compression: no file reference, skipping')
    return { status: 'no-file-ref', rawBytes: 0, compressedBytes: null, checksum: null }
  }

  const rawKey = fileRef.key
  const bucket = fileRef.bucket
  const contentType = fileRef.contentType ?? 'application/octet-stream'
  const compressedKey = `${rawKey}.gz`

  let uploadId: string | null = null

  try {
    const response = await download(rawKey, bucket)
    const body = response.Body
    if (!body) {
      throw new Error(`no object body for storage key ${rawKey}`)
    }

    const hash = createHash('sha256')
    const gzip = createGzip()

    let rawBytes = 0
    let compressedBytes = 0
    let partNumber = 0
    const parts: Array<{ partNumber: number; etag: string }> = []
    let pending: Buffer[] = []
    let pendingLen = 0

    const flushPart = async (force: boolean): Promise<void> => {
      if (pendingLen === 0 || (!force && pendingLen < MULTIPART_MIN_PART_BYTES)) return
      if (uploadId === null) {
        uploadId = await createMPU(compressedKey, contentType, bucket)
      }
      const partBody = Buffer.concat(pending, pendingLen)
      pending = []
      pendingLen = 0
      partNumber += 1
      const etag = await uploadPartFn(compressedKey, uploadId, partNumber, partBody, bucket)
      parts.push({ partNumber, etag })
    }

    // Two concurrent loops driving the same gzip Transform: the writer reads
    // the raw object stream and feeds it into gzip (hashing each raw chunk
    // as it arrives, before compression); the reader consumes gzip's
    // compressed output and flushes multipart parts once enough has
    // accumulated. Neither loop ever holds more than one raw chunk or one
    // pending multipart part in memory.
    const writer = (async (): Promise<void> => {
      const stream = body.transformToWebStream()
      const reader = stream.getReader()
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- sequential stream read, cannot be parallelized
          const { done, value } = await reader.read()
          if (done) break
          const chunk = Buffer.from(value)
          rawBytes += chunk.length
          hash.update(chunk)
          if (!gzip.write(chunk)) {
            // oxlint-disable-next-line no-await-in-loop -- backpressure: wait for gzip to drain before reading more
            await once(gzip, 'drain')
          }
        }
        gzip.end()
      } catch (err) {
        // A rejected `reader.read()` must still end the gzip Transform's
        // lifecycle -- otherwise the concurrent `reading` loop (`for
        // await ... of gzip`) hangs forever awaiting output that will
        // never arrive. `destroy(err)`, not `end()`: `end()` would flush
        // whatever partial bytes are buffered and drive more
        // `uploadPart` calls during what is supposed to be an aborted
        // download.
        gzip.destroy(err instanceof Error ? err : new Error(String(err)))
        throw err
      } finally {
        await reader.cancel().catch(() => {})
      }
    })()

    const reading = (async (): Promise<void> => {
      for await (const chunk of gzip) {
        const buf = chunk as Buffer
        compressedBytes += buf.length
        pending.push(buf)
        pendingLen += buf.length
        // oxlint-disable-next-line no-await-in-loop -- must flush before consuming more of the async iterator
        await flushPart(false)
      }
      await flushPart(true)
    })()

    await Promise.all([writer, reading])

    const checksum = hash.digest('hex')

    if (uploadId !== null && compressedBytes < rawBytes) {
      await completeMPU(compressedKey, uploadId, parts, bucket)
      await db
        .update(table)
        .set({
          fileRef: { ...fileRef, key: compressedKey },
          compressionEncoding: 'gzip' satisfies ResourceCompressionEncoding,
          fileChecksum: checksum,
          fileSize: rawBytes,
          updatedAt: new Date(),
        })
        .where(eq(table.id, resourceId))
      await del(rawKey, bucket).catch((err: unknown) => {
        logger.warn(
          { err, resourceType, resourceId, key: rawKey },
          'resource-compression: failed to delete original raw object after compression; continuing'
        )
      })
      logger.info(
        { resourceType, resourceId, rawBytes, compressedBytes },
        'resource-compression: compressed'
      )
      return { status: 'compressed', rawBytes, compressedBytes, checksum }
    }

    if (uploadId !== null) {
      await abortMPU(compressedKey, uploadId, bucket).catch((err: unknown) => {
        logger.warn(
          { err, resourceType, resourceId, key: compressedKey },
          'resource-compression: failed to abort unhelpful compressed upload; continuing'
        )
      })
    }
    await db
      .update(table)
      .set({
        compressionEncoding: 'none' satisfies ResourceCompressionEncoding,
        fileChecksum: checksum,
        fileSize: rawBytes,
        updatedAt: new Date(),
      })
      .where(eq(table.id, resourceId))
    logger.info(
      { resourceType, resourceId, rawBytes, compressedBytes },
      'resource-compression: kept raw (compression did not shrink the object)'
    )
    return { status: 'kept-raw', rawBytes, compressedBytes, checksum }
  } catch (err) {
    if (uploadId !== null) {
      await abortMPU(compressedKey, uploadId, bucket).catch((abortErr: unknown) => {
        logger.warn(
          { err: abortErr, resourceType, resourceId, key: compressedKey },
          'resource-compression: failed to abort multipart upload after error; continuing'
        )
      })
    }
    logger.error(
      { err, resourceType, resourceId },
      'resource-compression: failed; resource remains raw and retriable'
    )
    throw err
  }
}
