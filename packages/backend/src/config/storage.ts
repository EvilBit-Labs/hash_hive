import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { NodeHttpHandler } from '@smithy/node-http-handler'

import { env } from './env.js'
import { logger } from './logger.js'

// Explicit connect + socket timeouts so a slow or hung S3 endpoint cannot
// indefinitely tie up a worker slot or a route handler. Without these the
// AWS SDK falls back to OS defaults (often minutes); a parser or DELETE
// stuck on an unreachable bucket would consume the BullMQ slot forever.
const S3_CONNECT_TIMEOUT_MS = 5_000
const S3_SOCKET_TIMEOUT_MS = 30_000

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: S3_CONNECT_TIMEOUT_MS,
    socketTimeout: S3_SOCKET_TIMEOUT_MS,
  }),
})

export async function uploadFile(
  key: string,
  body: Buffer | ReadableStream,
  contentType: string,
  bucket?: string
) {
  return s3.send(
    new PutObjectCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  )
}

export async function downloadFile(key: string, bucket?: string) {
  return s3.send(
    new GetObjectCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
    })
  )
}

export async function deleteFile(key: string, bucket?: string) {
  // Validate key shape to defend against a hostile fileRef.key — even
  // though current writers always derive keys server-side, the JSONB
  // column means a future endpoint could let user input flow here.
  if (key.startsWith('/') || key.includes('..')) {
    throw new Error(`Invalid S3 object key: ${key}`)
  }
  return s3.send(
    new DeleteObjectCommand({
      // Bucket override is intentionally limited: only env.S3_BUCKET is
      // currently in use, but the param is retained for tests/multi-bucket
      // futures. If `bucket` is supplied it must equal env.S3_BUCKET — we
      // refuse to issue a DeleteObject against an arbitrary bucket the IAM
      // credentials may also have access to.
      Bucket: assertAllowedBucket(bucket),
      Key: key,
    })
  )
}

/**
 * Probes whether an object exists without downloading its body (issue #108
 * safety foundation for content-addressed blob storage). Used by the
 * content-addressed dedup path (`uploadResourceFile` and
 * `compressChunkedResourceObject`) to check "does `blobs/<checksum>` already
 * exist in the store" before deciding to skip a re-upload.
 *
 * A missing object is a normal, expected outcome here (not an error): it
 * resolves to `{ exists: false }` rather than throwing. Any other failure
 * (auth, network, wrong bucket) rethrows so it surfaces like every other
 * storage call.
 */
export async function headObject(
  key: string,
  bucket?: string
): Promise<{ exists: boolean; size?: number }> {
  try {
    const response = await s3.send(
      new HeadObjectCommand({
        Bucket: assertAllowedBucket(bucket),
        Key: key,
      })
    )
    return response.ContentLength != null
      ? { exists: true, size: response.ContentLength }
      : { exists: true }
  } catch (err) {
    if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') {
      return { exists: false }
    }
    throw err
  }
}

/**
 * Server-side copy of an object to a new key within the same bucket (issue
 * #108 safety foundation). Used by `compressChunkedResourceObject` to
 * relocate a just-completed chunked-upload object onto its content-addressed
 * `blobs/<checksum>` key without a client round-trip. Callers that invoke
 * this as part of content-addressing must treat a thrown error as a safe,
 * non-fatal "skip dedup for this object" signal — not every storage backend
 * necessarily supports server-side copy.
 */
export async function copyObject(
  sourceKey: string,
  destKey: string,
  bucket?: string
): Promise<void> {
  const resolvedBucket = assertAllowedBucket(bucket)
  await s3.send(
    new CopyObjectCommand({
      Bucket: resolvedBucket,
      CopySource: `${resolvedBucket}/${sourceKey}`,
      Key: destKey,
    })
  )
}

function assertAllowedBucket(bucket: string | undefined): string {
  if (bucket && bucket !== env.S3_BUCKET) {
    throw new Error(`Refusing to operate on bucket "${bucket}": only "${env.S3_BUCKET}" is allowed`)
  }
  return env.S3_BUCKET
}

// Conservative ASCII charset for `filename=` (the legacy fallback). Anything
// outside the whitelist is replaced with `_` so a hostile filename can't
// break the Content-Disposition header.
const ASCII_FILENAME_FALLBACK_PATTERN = /[^\w.-]/g
const MAX_FILENAME_LENGTH = 200

/**
 * Build an RFC 5987-compliant Content-Disposition value for the presigned
 * GET URL. We emit BOTH `filename=` (ASCII fallback for ancient clients)
 * and `filename*=UTF-8''<percent-encoded>` (modern clients, full Unicode).
 * Control chars, RTL overrides, and structural chars (`"`, `;`, `\r`,
 * `\n`) are stripped before encoding.
 */
function buildContentDisposition(filename: string): string {
  const trimmed = filename.slice(0, MAX_FILENAME_LENGTH)
  // Strip all C0/C1 controls + DEL + RTL override (U+202E) + replacement (U+FFFD).
  const cleaned = trimmed.replace(
    // oxlint-disable-next-line no-control-regex -- explicitly stripping C0/C1 controls
    /[\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩�]/g,
    ''
  )
  const asciiFallback = cleaned.replace(ASCII_FILENAME_FALLBACK_PATTERN, '_') || 'download'
  const utf8Encoded = encodeURIComponent(cleaned)
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`
}

export async function getPresignedUrl(
  key: string,
  expiresIn = 3600,
  opts?: { bucket?: string; filename?: string }
): Promise<string> {
  const disposition = opts?.filename ? buildContentDisposition(opts.filename) : undefined
  // Same bucket allowlist as deleteFile: refuse to issue a presigned
  // download URL for any bucket other than env.S3_BUCKET. Defends
  // against a hostile/forged fileRef.bucket ever leaking into this
  // call site and producing a presigned URL for an unrelated bucket
  // the IAM credentials happen to reach.
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: assertAllowedBucket(opts?.bucket),
      Key: key,
      ...(disposition ? { ResponseContentDisposition: disposition } : {}),
    }),
    { expiresIn }
  )
}

/**
 * Probes the configured object store (SeaweedFS in dev / air-gapped prod,
 * AWS S3 anywhere else) by issuing a `HeadBucket` against `S3_BUCKET`.
 * Returns `{status, bucket}` so the caller's structured log carries the
 * bucket name regardless of outcome.
 */
export async function checkObjectStoreHealth(signal?: AbortSignal): Promise<{
  status: 'connected' | 'disconnected'
  bucket: string
}> {
  try {
    // Only attach `abortSignal` when actually provided —
    // exactOptionalPropertyTypes refuses `{ abortSignal: undefined }`.
    const opts = signal ? { abortSignal: signal } : undefined
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }), opts)
    return { status: 'connected', bucket: env.S3_BUCKET }
  } catch (err) {
    // Suppress noisy timeout aborts (the probe wrapper already logs and
    // marks the component unhealthy). Log everything else server-side
    // so a persistent S3/auth/bucket regression is visible in
    // production logs, not silently masked behind a 'disconnected'
    // reading.
    const isAbort = err instanceof Error && err.name === 'AbortError'
    if (!isAbort) {
      logger.warn({ err, bucket: env.S3_BUCKET }, 'object store health check failed')
    }
    return { status: 'disconnected', bucket: env.S3_BUCKET }
  }
}

export async function createMultipartUpload(
  key: string,
  contentType: string,
  bucket?: string
): Promise<string> {
  const response = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
    })
  )
  if (!response.UploadId) {
    throw new Error('Failed to initiate multipart upload: no UploadId returned')
  }
  return response.UploadId
}

export async function uploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
  bucket?: string
): Promise<string> {
  const response = await s3.send(
    new UploadPartCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.byteLength,
    })
  )
  if (!response.ETag) {
    throw new Error(`No ETag returned for part ${partNumber}`)
  }
  return response.ETag
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  bucket?: string
): Promise<void> {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    })
  )
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
  bucket?: string
): Promise<void> {
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  )
}

export async function listParts(
  key: string,
  uploadId: string,
  bucket?: string
): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
  const allParts: Array<{ partNumber: number; etag: string; size: number }> = []
  let partNumberMarker: string | undefined

  while (true) {
    const response = await s3.send(
      new ListPartsCommand({
        Bucket: bucket ?? env.S3_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: partNumberMarker,
      })
    )

    for (const part of response.Parts ?? []) {
      if (part.PartNumber != null && part.ETag) {
        allParts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size ?? 0,
        })
      }
    }

    if (!response.IsTruncated) break
    partNumberMarker =
      response.NextPartNumberMarker != null ? String(response.NextPartNumberMarker) : undefined
  }

  return allParts
}
