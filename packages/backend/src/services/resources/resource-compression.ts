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
  copyObject as copyObjectDefault,
  createMultipartUpload as createMultipartUploadDefault,
  deleteFile as deleteFileDefault,
  downloadFile as downloadFileDefault,
  headObject as headObjectDefault,
  uploadPart as uploadPartDefault,
} from '../../config/storage.js'
import { db } from '../../db/index.js'
import { deleteBlobIfUnreferenced } from './blob-lifecycle.js'
import { blobKeyForChecksum } from './content-address.js'
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
  headObject: typeof headObjectDefault
  copyObject: typeof copyObjectDefault
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
  const headObj = deps.headObject ?? headObjectDefault
  const copyObj = deps.copyObject ?? copyObjectDefault

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

    // Bidirectional teardown signal for the two loops below (writer/reading)
    // sharing this one Transform. Set up ONCE, right after `createGzip()`
    // and before any await, so: (a) it is never missed by a 'close' that
    // fires before a listener would otherwise attach, and (b) `events.once`
    // registers its own 'error' listener as a side effect, which prevents an
    // unhandled-'error' process crash if `reading`'s catch below calls
    // `gzip.destroy(err)` at a moment the writer isn't parked on `drain`.
    // The eager `.catch(() => {})` is required because this promise almost
    // always settles (gzip always closes, even on the happy path, once both
    // loops finish) with nothing else consuming it by then.
    const gzipTornDown: Promise<never> = once(gzip, 'close').then(() => {
      throw new Error('resource-compression: gzip stream closed before this wait resolved')
    })
    gzipTornDown.catch(() => {})

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
            // Race the normal backpressure signal against gzip tearing down.
            // Without this, a non-final `uploadPart` rejection inside the
            // concurrent `reading` loop below (which destroys gzip on
            // error, see its catch block) would never wake this writer --
            // 'drain' never fires once nothing is consuming gzip's output
            // any more, leaking this loop's promise and the raw S3
            // download stream it holds open. Resolving either way is
            // enough: the `for (;;)` loop's next `gzip.write()` on an
            // already-destroyed stream (or the throw below) drives this
            // loop into its own `catch`/`finally`, which cancels `reader`.
            // oxlint-disable-next-line no-await-in-loop -- backpressure: wait for gzip to drain (or tear down) before reading more
            await Promise.race([once(gzip, 'drain'), gzipTornDown])
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
        await reader.cancel().catch((cancelErr: unknown) => {
          logger.warn(
            { err: cancelErr, resourceType, resourceId, key: rawKey },
            'resource-compression: failed to cancel raw download reader during teardown; continuing'
          )
        })
      }
    })()

    const reading = (async (): Promise<void> => {
      try {
        for await (const chunk of gzip) {
          const buf = chunk as Buffer
          compressedBytes += buf.length
          pending.push(buf)
          pendingLen += buf.length
          // oxlint-disable-next-line no-await-in-loop -- must flush before consuming more of the async iterator
          await flushPart(false)
        }
        await flushPart(true)
      } catch (err) {
        // A rejected (non-final) `uploadPart` call must still tear down the
        // gzip Transform -- otherwise the concurrent `writer` loop above can
        // be parked forever on `once(gzip, 'drain')` (see `gzipTornDown`),
        // leaking the writer's promise and the raw download stream it
        // holds. `destroy(err)`, not a plain return: it both wakes the
        // writer via `gzipTornDown` and stops gzip from accepting further
        // writes.
        gzip.destroy(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    })()

    await Promise.all([writer, reading])

    const checksum = hash.digest('hex')
    const blobKey = blobKeyForChecksum(checksum)

    if (uploadId !== null && compressedBytes < rawBytes) {
      await completeMPU(compressedKey, uploadId, parts, bucket)

      // Content-addressing (#108 dedup follow-up): relocate the
      // just-completed compressed object onto the GLOBAL content-addressed
      // key so identical raw content from any other upload dedups onto the
      // same physical blob. `headObj` tells us whether some other upload
      // already got there first; if so we discard both of our own temp
      // objects instead of keeping a second copy of the same content. The
      // encoding is NOT re-read from any other row or defaulted -- this
      // worker just streamed the content itself and already knows
      // `compressedBytes < rawBytes` is true (that's how it got into this
      // branch), so `'gzip'` is this worker's own authoritative, directly
      // computed result for this exact content, not a guess (#108 review:
      // reading `findCompressionEncodingForKey` here could race a
      // concurrent reclaim/delete of the referencing row and silently fall
      // back to a wrong literal).
      let finalKey = compressedKey
      const finalEncoding: ResourceCompressionEncoding = 'gzip'
      const existingBlob = await headObj(blobKey, bucket)
      if (existingBlob.exists) {
        finalKey = blobKey
        await deleteBlobIfUnreferenced({
          table,
          resourceId,
          key: compressedKey,
          ...(bucket ? { bucket } : {}),
          deleteFn: del,
        })
      } else {
        try {
          await copyObj(compressedKey, blobKey, bucket)
          finalKey = blobKey
          await deleteBlobIfUnreferenced({
            table,
            resourceId,
            key: compressedKey,
            ...(bucket ? { bucket } : {}),
            deleteFn: del,
          })
        } catch (copyErr) {
          // Safe fallback (e.g. a storage backend without server-side copy
          // support): keep serving this object from its temp compressed
          // key. Still fully correct — just not deduped against any future
          // identical upload. Never fails the job over this.
          logger.warn(
            { err: copyErr, resourceType, resourceId, compressedKey, blobKey },
            'resource-compression: copyObject to content-addressed key failed; keeping temp compressed key (no dedup for this object)'
          )
        }
      }
      // #108 safety foundation: guarded delete of the discarded raw object,
      // not a bare `del` — its content now lives at `finalKey` either way
      // (relocated to `blobKey`, or still `compressedKey` on the copy
      // fallback above). A no-op today (this row's raw key is unique to
      // it), but this is a blob-delete site alongside
      // `blob-reclamation.ts`/`resources.ts` — the same guard applies
      // wherever a committed word/rule/mask-list blob gets deleted.
      await deleteBlobIfUnreferenced({
        table,
        resourceId,
        key: rawKey,
        ...(bucket ? { bucket } : {}),
        deleteFn: del,
      })

      await db
        .update(table)
        .set({
          fileRef: { ...fileRef, key: finalKey },
          compressionEncoding: finalEncoding,
          fileChecksum: checksum,
          fileSize: rawBytes,
          updatedAt: new Date(),
        })
        .where(eq(table.id, resourceId))
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

    // Content-addressing for the kept-raw/incompressible case: the raw
    // object itself is what should end up at the content-addressed key —
    // same dedup-or-copy decision as the compressed branch above, just
    // sourced from `rawKey` instead of a compressed temp object. Same
    // authoritative-encoding reasoning as above: this worker already
    // measured `compressedBytes >= rawBytes` for this exact content (that's
    // how it got into this branch), so `'none'` is this worker's own
    // directly computed result, never adopted or defaulted from elsewhere.
    let finalKey = rawKey
    const finalEncoding: ResourceCompressionEncoding = 'none'
    const existingRawBlob = await headObj(blobKey, bucket)
    if (existingRawBlob.exists) {
      finalKey = blobKey
      await deleteBlobIfUnreferenced({
        table,
        resourceId,
        key: rawKey,
        ...(bucket ? { bucket } : {}),
        deleteFn: del,
      })
    } else {
      try {
        await copyObj(rawKey, blobKey, bucket)
        finalKey = blobKey
        await deleteBlobIfUnreferenced({
          table,
          resourceId,
          key: rawKey,
          ...(bucket ? { bucket } : {}),
          deleteFn: del,
        })
      } catch (copyErr) {
        logger.warn(
          { err: copyErr, resourceType, resourceId, rawKey, blobKey },
          'resource-compression: copyObject to content-addressed key failed; keeping temp raw key (no dedup for this object)'
        )
      }
    }

    await db
      .update(table)
      .set({
        fileRef: { ...fileRef, key: finalKey },
        compressionEncoding: finalEncoding,
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
