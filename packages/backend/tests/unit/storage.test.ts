/**
 * Unit tests for `packages/backend/src/config/storage.ts`'s content-addressed
 * dedup safety helpers (PR #282 review fixes):
 *
 *  - `headObject`'s "missing object" detection must work across
 *    S3-compatible backends that signal a miss differently: the AWS SDK's
 *    `NotFound` error class/name, SeaweedFS/MinIO's `NoSuchKey` error name,
 *    or a bare `404` on `$metadata.httpStatusCode` with no distinguishing
 *    error name at all. Any other failure (auth, network, 5xx) must still
 *    rethrow -- a real operational error must never be swallowed as "not
 *    found" (that would make `compressChunkedResourceObject`'s dedup fast
 *    path silently treat a broken storage backend as "safe to re-upload").
 *  - `copyObject`'s `CopySource` must URL-encode the source key's path
 *    segments (keeping literal `/` separators) so keys containing spaces,
 *    `+`, `#`, or unicode survive the single combined `bucket/key` header
 *    value S3's CopyObject API expects.
 *
 * Runs in an isolated bun:test phase (STORAGE_TEST_ISOLATED=1). This suite
 * monkey-patches the REAL `s3` singleton's `send` to exercise the real
 * `headObject`/`copyObject` end to end with zero network calls. In the shared
 * catch-all phase, other test files `mock.module('config/storage')` (without
 * exporting `s3`), and on some file orderings that leaked module would make a
 * top-level `s3.send.bind(s3)` throw before any test runs. The `IS_ISOLATED`
 * guard keeps every `s3`-touching statement out of the catch-all phase, so the
 * leak can never reach this file. See GOTCHAS.md on `mock.module` leakage and
 * the isolated-phase convention.
 */
import { CopyObjectCommand } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it } from 'bun:test'

import { env } from '../../src/config/env.js'
import { copyObject, headObject, s3 } from '../../src/config/storage.js'

const IS_ISOLATED = process.env['STORAGE_TEST_ISOLATED'] === '1'

type SendFn = (...args: unknown[]) => Promise<unknown>

if (!IS_ISOLATED) {
  describe('storage helpers (isolated)', () => {
    it('skipped — set STORAGE_TEST_ISOLATED=1 to run; this suite did NOT execute in this phase', () => {
      expect(process.env['STORAGE_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  const originalSend = s3.send.bind(s3) as unknown as SendFn

  const fakeSend = (fn: SendFn): void => {
    ;(s3 as unknown as { send: SendFn }).send = fn
  }

  afterEach(() => {
    ;(s3 as unknown as { send: SendFn }).send = originalSend
  })

  const errorWithName = (name: string): Error => {
    const err = new Error(`simulated ${name}`)
    err.name = name
    return err
  }

  const errorWithStatus = (statusCode: number): Error & { $metadata: { httpStatusCode: number } } =>
    Object.assign(new Error('simulated status-only error'), {
      $metadata: { httpStatusCode: statusCode },
    })

  describe('headObject missing-object detection (PR #282 review Fix 1)', () => {
    it('treats a NotFound-named error as a miss (AWS SDK)', async () => {
      fakeSend(() => Promise.reject(errorWithName('NotFound')))
      const result = await headObject('blobs/does-not-exist')
      expect(result).toEqual({ exists: false })
    })

    it('treats a NoSuchKey-named error as a miss (SeaweedFS/MinIO)', async () => {
      fakeSend(() => Promise.reject(errorWithName('NoSuchKey')))
      const result = await headObject('blobs/does-not-exist')
      expect(result).toEqual({ exists: false })
    })

    it('treats a bare 404 status with no distinguishing error name as a miss', async () => {
      fakeSend(() => Promise.reject(errorWithStatus(404)))
      const result = await headObject('blobs/does-not-exist')
      expect(result).toEqual({ exists: false })
    })

    it('rethrows a non-404 error instead of treating it as a miss', async () => {
      fakeSend(() => Promise.reject(errorWithStatus(500)))
      await expect(headObject('blobs/whatever')).rejects.toThrow('simulated status-only error')
    })

    it('rethrows an error with neither a matching name nor a 404 status', async () => {
      fakeSend(() => Promise.reject(new Error('connection reset')))
      await expect(headObject('blobs/whatever')).rejects.toThrow('connection reset')
    })

    it('resolves { exists: true, size } on a successful head', async () => {
      fakeSend(() => Promise.resolve({ ContentLength: 42 }))
      const result = await headObject('blobs/present')
      expect(result).toEqual({ exists: true, size: 42 })
    })
  })

  describe('copyObject CopySource encoding (PR #282 review Fix 2)', () => {
    it("URL-encodes each path segment of the source key, preserving literal '/' separators", async () => {
      let captured: CopyObjectCommand | undefined
      fakeSend((command: unknown) => {
        captured = command as CopyObjectCommand
        return Promise.resolve({})
      })

      await copyObject('uploads/a file+name#1.txt', 'blobs/deadbeef')

      expect(captured).toBeInstanceOf(CopyObjectCommand)
      expect(captured!.input.CopySource).toBe(
        `${env.S3_BUCKET}/uploads/${encodeURIComponent('a file+name#1.txt')}`
      )
      expect(captured!.input.CopySource).not.toContain(' ')
    })

    it('encodes a unicode key segment', async () => {
      let captured: CopyObjectCommand | undefined
      fakeSend((command: unknown) => {
        captured = command as CopyObjectCommand
        return Promise.resolve({})
      })

      await copyObject('uploads/日本語.txt', 'blobs/deadbeef')

      expect(captured!.input.CopySource).toBe(
        `${env.S3_BUCKET}/uploads/${encodeURIComponent('日本語.txt')}`
      )
    })

    it('leaves a hex-safe key unchanged (no-op for current content-addressed key shapes)', async () => {
      let captured: CopyObjectCommand | undefined
      fakeSend((command: unknown) => {
        captured = command as CopyObjectCommand
        return Promise.resolve({})
      })

      await copyObject('blobs/abc123', 'blobs/def456')

      expect(captured!.input.CopySource).toBe(`${env.S3_BUCKET}/blobs/abc123`)
    })
  })
}
