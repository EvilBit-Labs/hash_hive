/**
 * Shared helpers, schemas, and constants for the resources surface.
 *
 * Factored out of `resources.ts` so `resources-generic.ts` (the
 * wordlists/rulelists/masklists factory) and `resources-chunked-upload.ts`
 * (the S3 multipart upload session routes) can import them without
 * creating an import cycle back through the main router module.
 */

import { z } from '@hono/zod-openapi'

import { MAX_DIRECT_UPLOAD_BYTES } from '../../services/resources.js'

// Cap the multipart wire body slightly above the direct-upload limit. The
// extra 1 MB covers multipart overhead (boundaries, field headers) so a
// genuine 10 MB file isn't rejected by the wire-size check before it
// reaches the byte-size check in `uploadHashListFile`. Anything larger
// is rejected before parseBody so the server doesn't buffer GBs into
// memory.
export const MULTIPART_BODY_LIMIT_BYTES = MAX_DIRECT_UPLOAD_BYTES + 1_048_576

/**
 * Reject oversize multipart payloads BEFORE `c.req.parseBody()` buffers
 * the whole body. Two protections:
 *   1. `Transfer-Encoding: chunked` lacks Content-Length, so the cap
 *      below can't enforce. Reject chunked outright (411) and steer
 *      the caller to the streaming chunked-upload endpoint.
 *   2. Declared Content-Length above `MULTIPART_BODY_LIMIT_BYTES` →
 *      413 PAYLOAD_TOO_LARGE.
 * `uploadHashListFile` / `uploadResourceFile` enforce the post-parse
 * byte cap via `UploadTooLargeError` as a backstop. Without this
 * pre-parse guard an authenticated admin/contributor could OOM the
 * backend with a multi-GB body.
 *
 * Returns a Response when the request must be rejected; returns null
 * when the caller should proceed to parseBody().
 */
export function enforceMultipartSizeLimit(c: {
  req: { header: (k: string) => string | undefined }
  json: (body: unknown, status: number) => Response
}): Response | null {
  const transferEncoding = (c.req.header('transfer-encoding') ?? '').toLowerCase()
  if (transferEncoding.includes('chunked')) {
    return c.json(
      {
        error: {
          code: 'LENGTH_REQUIRED',
          message:
            'Multipart uploads must include Content-Length. Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for streamed/large files.',
        },
      },
      411
    )
  }
  const contentLengthRaw = c.req.header('content-length')
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined
  if (
    typeof contentLength === 'number' &&
    Number.isFinite(contentLength) &&
    contentLength > MULTIPART_BODY_LIMIT_BYTES
  ) {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Multipart body (${contentLength} bytes) exceeds ${MULTIPART_BODY_LIMIT_BYTES} bytes. Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for larger files.`,
        },
      },
      413
    )
  }
  return null
}

/**
 * Shared query-shape validator for the chunked-upload GET-status /
 * DELETE-abort endpoints. Both routes accept `uploadId` (path) plus
 * `resourceId` (positive integer query) + `resourceType` (one of the
 * known resource buckets) — truthiness checks alone admitted
 * `resourceId=-1` and arbitrary `resourceType` strings, leaking
 * invalid input into the service layer.
 */
export const RESOURCE_TYPES = ['hash-lists', 'wordlists', 'rulelists', 'masklists'] as const
export const uploadStatusQuerySchema = z.object({
  resourceId: z.coerce.number().int().positive(),
  resourceType: z.enum(RESOURCE_TYPES),
})

/**
 * Generic placeholder schema for response shapes that don't have a
 * corresponding shared Zod schema yet. Each placeholder advertises
 * `additionalProperties: true` in the spec; the embedded `description`
 * tells consumers it's transitional rather than a deliberate
 * polymorphic / "object of anything" contract. Per-route uses of
 * `z.object({}).passthrough().openapi('Name')` elsewhere should
 * follow the same convention — promote to a real `@hashhive/shared`
 * schema as that wire shape stabilizes.
 */
export const passthroughObject = (name: string) =>
  z.object({}).passthrough().openapi(name, {
    description:
      'Schema pending: response shape will be promoted into `@hashhive/shared` in a follow-up. Until then this is a placeholder; consumers should not treat additional fields as a stable contract.',
  })

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const uploadIdParamSchema = z.object({
  uploadId: z.string().min(1),
})

export const uploadPartParamSchema = z.object({
  uploadId: z.string().min(1),
  partNumber: z.coerce.number().int().positive(),
})

// The library types `tags` as `string[]` and `security` as
// `SecurityRequirementObject[]` (mutable), so `as const` makes them
// non-assignable. They stay as plain mutable arrays; the discipline
// against `tags.push(...)` lives in the project review checklist.
export const tags: string[] = ['Resources']
export const security = [{ SessionCookie: [] }]
