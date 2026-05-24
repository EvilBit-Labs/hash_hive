import type { ChunkDescriptor, PersistedUploadState, UploadProgress } from './types'

import { clearUploadState, saveUploadState } from './persistence'

const DEFAULT_CHUNK_SIZE = 64 * 1024 * 1024 // 64 MB
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

const UPLOAD_BASE = '/api/v1/dashboard/resources/upload'

export function createChunks(
  fileSize: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): ChunkDescriptor[] {
  const chunks: ChunkDescriptor[] = []
  let offset = 0
  let index = 0

  while (offset < fileSize) {
    const end = Math.min(offset + chunkSize, fileSize)
    chunks.push({
      index,
      partNumber: index + 1, // 1-based for S3
      start: offset,
      end,
    })
    offset = end
    index++
  }

  return chunks
}

export async function initiateUpload(
  resourceType: string,
  name: string,
  fileSize: number,
  contentType?: string
): Promise<{ uploadId: string; resourceId: number; partSize: number }> {
  const body: Record<string, unknown> = { resourceType, name, fileSize }
  if (contentType) {
    body['contentType'] = contentType
  }

  const res = await fetch(`${UPLOAD_BASE}/initiate`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}))
    const message =
      (errorBody as { error?: { message?: string } }).error?.message ?? 'Failed to initiate upload'
    throw new Error(message)
  }

  return res.json()
}

export async function uploadChunk(
  file: File,
  chunk: ChunkDescriptor,
  uploadId: string,
  resourceId: number,
  resourceType: string,
  signal: AbortSignal
): Promise<{ etag: string }> {
  const blob = file.slice(chunk.start, chunk.end)
  const buffer = await blob.arrayBuffer()

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError')
    }

    try {
      const url = `${UPLOAD_BASE}/${uploadId}/part/${chunk.partNumber}?resourceId=${resourceId}&resourceType=${encodeURIComponent(resourceType)}`

      const res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
        signal,
      })

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}))
        const message =
          (errorBody as { error?: { message?: string } }).error?.message ??
          `Part ${chunk.partNumber} upload failed`
        throw new Error(message)
      }

      return res.json()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }

      lastError = err instanceof Error ? err : new Error(String(err))

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt
        await sleep(delay, signal)
      }
    }
  }

  throw lastError ?? new Error(`Part ${chunk.partNumber} upload failed after retries`)
}

export async function completeUpload(
  uploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  resourceId: number,
  resourceType: string
): Promise<{ resourceId: number }> {
  const res = await fetch(`${UPLOAD_BASE}/${uploadId}/complete`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts, resourceId, resourceType }),
  })

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}))
    const message =
      (errorBody as { error?: { message?: string } }).error?.message ?? 'Failed to complete upload'
    throw new Error(message)
  }

  return res.json()
}

export async function abortUpload(
  uploadId: string,
  resourceId: number,
  resourceType: string
): Promise<void> {
  const url = `${UPLOAD_BASE}/${uploadId}?resourceId=${resourceId}&resourceType=${encodeURIComponent(resourceType)}`

  const res = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  })

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}))
    const message =
      (errorBody as { error?: { message?: string } }).error?.message ?? 'Failed to abort upload'
    throw new Error(message)
  }
}

export interface UploadOrchestrationOptions {
  readonly file: File
  readonly resourceType: string
  readonly name: string
  readonly onProgress?: (progress: UploadProgress) => void
  readonly signal: AbortSignal
}

export async function orchestrateUpload(options: UploadOrchestrationOptions): Promise<number> {
  const { file, resourceType, name, onProgress, signal } = options

  const { uploadId, resourceId, partSize } = await initiateUpload(
    resourceType,
    name,
    file.size,
    file.type || undefined
  )

  const chunks = createChunks(file.size, partSize)
  const completedParts: Array<{ partNumber: number; etag: string }> = []

  const persistState = (): PersistedUploadState => {
    const now = new Date().toISOString()
    const state: PersistedUploadState = {
      uploadId,
      resourceId,
      resourceType,
      fileName: file.name,
      fileSize: file.size,
      partSize,
      completedParts: [...completedParts],
      startedAt: now,
      updatedAt: now,
    }
    saveUploadState(uploadId, state)
    return state
  }

  persistState()

  try {
    for (const chunk of chunks) {
      if (signal.aborted) {
        throw new DOMException('Upload cancelled', 'AbortError')
      }

      const { etag } = await uploadChunk(file, chunk, uploadId, resourceId, resourceType, signal)
      completedParts.push({ partNumber: chunk.partNumber, etag })
      persistState()

      if (onProgress) {
        const uploadedBytes = chunk.end
        onProgress({
          totalBytes: file.size,
          uploadedBytes,
          percentage: Math.round((uploadedBytes / file.size) * 100),
          currentPart: chunk.partNumber,
          totalParts: chunks.length,
        })
      }
    }

    const result = await completeUpload(uploadId, completedParts, resourceId, resourceType)
    clearUploadState(uploadId)
    return result.resourceId
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Attempt to abort server-side, but don't throw if it fails
      try {
        await abortUpload(uploadId, resourceId, resourceType)
      } catch {
        // Best-effort cleanup
      }
      clearUploadState(uploadId)
    }
    throw err
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }

    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
