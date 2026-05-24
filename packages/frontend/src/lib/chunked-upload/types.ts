export interface ChunkDescriptor {
  readonly index: number
  readonly partNumber: number // 1-based for S3
  readonly start: number
  readonly end: number
}

export interface UploadProgress {
  readonly totalBytes: number
  readonly uploadedBytes: number
  readonly percentage: number
  readonly currentPart: number
  readonly totalParts: number
}

export interface PersistedUploadState {
  readonly uploadId: string
  readonly resourceId: number
  readonly resourceType: string
  readonly fileName: string
  readonly fileSize: number
  readonly partSize: number
  readonly completedParts: ReadonlyArray<{ partNumber: number; etag: string }>
  readonly startedAt: string
  readonly updatedAt: string
}
