/**
 * SHA-256 checksum helpers for word/rule/mask list uploads (issue #106 U12).
 *
 * `file_checksum` is captured at every upload finalization (direct and
 * chunked) so a resource whose blob is later reclaimed by the
 * blob-reclamation worker (U11) can be restored by re-uploading the
 * identical file: the re-upload's checksum is compared against the stored
 * value, and `blob_reclaimed_at` is only cleared on a match (R12).
 *
 * Issue #108 (File Integrity Verification) is the intended long-term
 * provider of checksum capture; these are a minimal SHA-256 comparison
 * standing in until #108 lands (see the plan's Key Technical Decisions).
 */
import { createHash } from 'node:crypto'

import { downloadFile } from '../../config/storage.js'

/** SHA-256 hex digest of an in-memory buffer (the direct/single-shot upload path). */
export function sha256HexFromBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * SHA-256 hex digest of an object already persisted in storage, computed by
 * streaming the download through the hash rather than buffering the whole
 * object in memory — used by the chunked/multipart upload finalize path,
 * where the file may be arbitrarily large and was never fully buffered
 * server-side (that's the point of chunked upload).
 *
 * @throws if the object has no readable body (a genuine storage failure).
 */
export async function sha256HexFromObject(key: string, bucket?: string): Promise<string> {
  const response = await downloadFile(key, bucket)
  const body = response.Body
  if (!body) {
    throw new Error(`No file body for storage key ${key}`)
  }

  const stream = body.transformToWebStream()
  const reader = stream.getReader()
  const hash = createHash('sha256')

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- sequential stream read, cannot be parallelized
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  return hash.digest('hex')
}
