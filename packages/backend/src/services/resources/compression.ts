/**
 * Buffer-level gzip helper for direct-upload compression (issue #108 U3).
 *
 * Gzip specifically (not a generic deflate/brotli choice): Go's stdlib
 * `compress/gzip` decompresses it natively, which matters for the downstream
 * hashcat agent that pulls the stored bytes back down. When compression
 * doesn't actually shrink the payload (already-compressed content, very
 * small files where the gzip header/trailer overhead dominates), the
 * original bytes are kept and reported as `'none'` rather than paying the
 * CPU cost for a net loss.
 *
 * A sync buffer helper is intentionally sufficient here: direct uploads are
 * capped at `MAX_DIRECT_UPLOAD_BYTES` (10 MB), so gzipping the whole buffer
 * in one call is cheap. The chunked-upload path (larger files, no in-memory
 * buffer) is a later unit's concern and will need a streaming variant.
 */
import { gzipSync } from 'node:zlib'

export type CompressionEncoding = 'gzip' | 'none'

export interface CompressedBuffer {
  bytes: Buffer
  encoding: CompressionEncoding
}

/**
 * Gzip `input` and return the compressed bytes when they are strictly
 * smaller than the original; otherwise return the original buffer unchanged
 * with encoding `'none'`.
 */
export function compressBufferForStorage(input: Buffer): CompressedBuffer {
  const gzipped = gzipSync(input)
  if (gzipped.length < input.length) {
    return { bytes: gzipped, encoding: 'gzip' }
  }
  return { bytes: input, encoding: 'none' }
}
