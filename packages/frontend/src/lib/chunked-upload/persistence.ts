import type { PersistedUploadState } from './types'

const STORAGE_PREFIX = 'hashhive:upload:'
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

export function saveUploadState(uploadId: string, state: PersistedUploadState): void {
  try {
    const key = `${STORAGE_PREFIX}${uploadId}`
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Storage full or unavailable — silently degrade
  }
}

export function loadUploadState(uploadId: string): PersistedUploadState | null {
  try {
    const key = `${STORAGE_PREFIX}${uploadId}`
    const raw = localStorage.getItem(key)
    if (!raw) return null

    const parsed: unknown = JSON.parse(raw)
    if (!isPersistedUploadState(parsed)) return null

    return parsed
  } catch {
    return null
  }
}

export function clearUploadState(uploadId: string): void {
  try {
    const key = `${STORAGE_PREFIX}${uploadId}`
    localStorage.removeItem(key)
  } catch {
    // Storage unavailable — nothing to clear
  }
}

export function getIncompleteUploads(): PersistedUploadState[] {
  const results: PersistedUploadState[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX)) continue

      const raw = localStorage.getItem(key)
      if (!raw) continue

      const parsed: unknown = JSON.parse(raw)
      if (isPersistedUploadState(parsed)) {
        results.push(parsed)
      }
    }
  } catch {
    // Storage unavailable
  }
  return results
}

export function cleanupStaleUploads(): void {
  const now = Date.now()
  try {
    const keysToRemove: string[] = []

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX)) continue

      const raw = localStorage.getItem(key)
      if (!raw) continue

      try {
        const parsed: unknown = JSON.parse(raw)
        if (
          isPersistedUploadState(parsed) &&
          now - new Date(parsed.updatedAt).getTime() > STALE_THRESHOLD_MS
        ) {
          keysToRemove.push(key)
        }
      } catch {
        // Corrupt entry — remove it
        keysToRemove.push(key)
      }
    }

    for (const key of keysToRemove) {
      localStorage.removeItem(key)
    }
  } catch {
    // Storage unavailable
  }
}

function isPersistedUploadState(value: unknown): value is PersistedUploadState {
  if (typeof value !== 'object' || value === null) return false

  const obj = value as Record<string, unknown>
  return (
    typeof obj['uploadId'] === 'string' &&
    typeof obj['resourceId'] === 'number' &&
    typeof obj['resourceType'] === 'string' &&
    typeof obj['fileName'] === 'string' &&
    typeof obj['fileSize'] === 'number' &&
    typeof obj['partSize'] === 'number' &&
    Array.isArray(obj['completedParts']) &&
    typeof obj['startedAt'] === 'string' &&
    typeof obj['updatedAt'] === 'string'
  )
}
