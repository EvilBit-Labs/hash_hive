import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useChunkedUpload } from '../../hooks/use-chunked-upload'
import {
  useCreateResource,
  useDeleteResource,
  useUploadResourceFile,
} from '../../hooks/use-resources'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { ErrorBanner } from '../ui/error-banner'
import { Input } from '../ui/input'

type ResourceType = 'hash-lists' | 'wordlists' | 'rulelists' | 'masklists'

const TYPE_LABELS: Record<ResourceType, string> = {
  'hash-lists': 'Hash List',
  wordlists: 'Wordlist',
  rulelists: 'Rulelist',
  masklists: 'Masklist',
}

// Must match the backend's MAX_DIRECT_UPLOAD_BYTES in
// packages/backend/src/services/resources.ts. Files over this size
// take the chunked path; files at or under it take the direct
// create-then-upload path. Drifting above the backend cap would 413
// every file in the gap and bounce them through the rollback flow.
const CHUNKED_UPLOAD_THRESHOLD = 10 * 1024 * 1024 // 10 MB

interface ResourceUploadModalProps {
  type: ResourceType
  open: boolean
  onClose: () => void
  onSuccess: (resourceId: number) => void
}

export function ResourceUploadModal({ type, open, onClose, onSuccess }: ResourceUploadModalProps) {
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // AbortController for the direct upload path so the user can cancel
  // a wedged upload without waiting for the 5-minute timeout. The
  // chunked path owns its own controller inside useChunkedUpload.
  const directUploadAbortRef = useRef<AbortController | null>(null)

  // Belt-and-suspenders cleanup: handleClose() aborts the direct
  // upload, but a parent that unmounts the modal without routing
  // through handleClose (tab switch, navigation, hot reload) would
  // otherwise leave the request alive and any setError / setName
  // calls in the in-flight handler would warn about updating an
  // unmounted component. The chunked path owns its own unmount
  // cleanup inside useChunkedUpload; this matches that.
  useEffect(() => {
    return () => {
      if (directUploadAbortRef.current) {
        directUploadAbortRef.current.abort()
        directUploadAbortRef.current = null
      }
    }
  }, [])

  const createResource = useCreateResource(type)
  const uploadFile = useUploadResourceFile(type)
  const deleteResource = useDeleteResource(type)

  const handleChunkedComplete = useCallback(
    (resourceId: number) => {
      onSuccess(resourceId)
      setName('')
      setFile(null)
      setError(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      onClose()
    },
    [onSuccess, onClose]
  )

  const handleChunkedError = useCallback((errorMessage: string) => {
    setError(errorMessage)
  }, [])

  const chunkedUpload = useChunkedUpload({
    onComplete: handleChunkedComplete,
    onError: handleChunkedError,
  })

  const isSmallUpload = createResource.isPending || uploadFile.isPending
  const isUploading = isSmallUpload || chunkedUpload.isUploading
  const label = TYPE_LABELS[type]
  const useChunkedPath = file !== null && file.size > CHUNKED_UPLOAD_THRESHOLD

  const adoptFile = useCallback(
    (selected: File | null) => {
      setFile(selected)
      if (selected && !name) {
        setName(selected.name.replace(/\.[^.]+$/, ''))
      }
    },
    [name]
  )

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    adoptFile(e.target.files?.[0] ?? null)
  }

  // Drag-and-drop handlers. preventDefault on dragover is required so
  // the drop event fires; the browser's default for dragover is to
  // cancel the drop. dragLeave can fire on child boundaries inside the
  // dropzone (the inner <input> or <label>), so we only flip off when
  // leaving the dropzone wrapper itself - keyed on currentTarget.
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!isUploading) setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) setIsDragOver(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    if (isUploading) return
    const dropped = e.dataTransfer.files[0] ?? null
    if (dropped) adoptFile(dropped)
  }

  // Keyboard activation for the dropzone - Enter/Space opens the file
  // picker so keyboard-only operators have the same affordance as
  // mouse users dragging in.
  const handleDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isUploading) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fileInputRef.current?.click()
    }
  }

  const handleUpload = async () => {
    if (!file || !name.trim()) return

    setError(null)

    if (useChunkedPath) {
      await chunkedUpload.start(file, type, name.trim())
      return
    }

    // Direct path (file <= CHUNKED_UPLOAD_THRESHOLD): two-step
    // create-then-upload. If the
    // upload step fails after the row is created we must roll back
    // the row, otherwise repeated retries multiply orphans. The
    // chunked path's backend handler already rolls back on multipart
    // failure; this client mirrors that contract for the direct path.
    let createdResourceId: number | null = null
    const controller = new AbortController()
    directUploadAbortRef.current = controller
    try {
      const result = await createResource.mutateAsync({ name: name.trim() })
      createdResourceId = result.item.id

      await uploadFile.mutateAsync({ id: createdResourceId, file, signal: controller.signal })

      onSuccess(createdResourceId)
      handleClose()
    } catch (err) {
      // Distinguish operator-cancel from server failure so the user
      // sees an actionable message rather than the bare DOMException.
      const isOperatorCancel = controller.signal.aborted && !isTimeoutAbort(err)
      if (createdResourceId !== null) {
        // Best-effort rollback. If the delete fails we expose the
        // orphan id to the operator so they can manually clean up
        // and so support can correlate. React Query's onSuccess
        // invalidation in the delete hook still fires so the orphan
        // disappears from the table if the delete eventually succeeds.
        try {
          await deleteResource.mutateAsync(createdResourceId)
        } catch (cleanupErr) {
          // oxlint-disable-next-line no-console -- diagnostic for orphan-row rollback failure
          console.warn('[resource-upload-modal] rollback delete failed for orphaned row', {
            resourceId: createdResourceId,
            error: cleanupErr,
          })
          setError(
            `${err instanceof Error ? err.message : 'Upload failed'} ` +
              `(orphan row id ${createdResourceId} could not be auto-cleaned; ` +
              `delete it manually or contact an admin).`
          )
          return
        }
      }
      if (isOperatorCancel) {
        setError('Upload cancelled.')
      } else {
        setError(err instanceof Error ? err.message : 'Upload failed')
      }
    } finally {
      directUploadAbortRef.current = null
    }
  }

  // Distinguish a TimeoutAbortSignal trigger from a manual abort so
  // the operator gets the right hint. AbortSignal.timeout() throws
  // with `name === 'TimeoutError'`; manual aborts throw with
  // `name === 'AbortError'`.
  function isTimeoutAbort(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'TimeoutError'
  }

  const handleReset = () => {
    setName('')
    setFile(null)
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleClose = () => {
    if (chunkedUpload.isUploading) {
      chunkedUpload.cancel()
    }
    if (directUploadAbortRef.current) {
      directUploadAbortRef.current.abort()
      directUploadAbortRef.current = null
    }
    handleReset()
    onClose()
  }

  if (!open) return null

  const chunkedProgress = chunkedUpload.state.progress
  const displayProgress = chunkedProgress ? chunkedProgress.percentage : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-crust/80">
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom modal: native <dialog> doesn't support the design system's surface tokens
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-upload-title"
        className="w-full max-w-md rounded-lg border border-surface-0 bg-mantle p-6 shadow-2xl"
      >
        <h3 id="resource-upload-title" className="mb-4 text-sm font-medium">
          Upload New {label}
        </h3>

        {error && <ErrorBanner message={error} className="mb-4" />}

        <div className="space-y-4">
          <div>
            <label htmlFor="resource-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              id="resource-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isUploading}
              className="mt-1.5"
              placeholder={`Enter ${label.toLowerCase()} name`}
            />
          </div>

          <div>
            <label htmlFor="resource-file" className="text-xs font-medium text-muted-foreground">
              File
            </label>
            <div
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- dropzone: needs to be a div to accept drag events on its full bounding box without nested-button focus traps
              role="button"
              tabIndex={isUploading ? -1 : 0}
              aria-label="Drop file here, or press Enter to browse"
              aria-disabled={isUploading}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onKeyDown={handleDropzoneKeyDown}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              className={cn(
                'mt-1.5 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                isDragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-surface-1 hover:border-surface-0',
                isUploading && 'cursor-not-allowed opacity-60'
              )}
            >
              {file ? (
                <>
                  <p className="text-xs font-medium text-foreground">{file.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {(file.size / (1024 * 1024)).toFixed(file.size < 10 * 1024 * 1024 ? 1 : 0)} MB
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs font-medium text-foreground">
                    Drop a file here or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">Any file type, up to several GB</p>
                </>
              )}
              <input
                id="resource-file"
                ref={fileInputRef}
                type="file"
                aria-label="Resource file"
                onChange={handleFileChange}
                disabled={isUploading}
                className="sr-only"
              />
            </div>
          </div>

          {isUploading && (
            <div className="space-y-1">
              {/* Determinate progress for chunked path, indeterminate
                  for direct path. `<progress>` without a `value`
                  attribute renders the browser's indeterminate
                  animation, automatically suppressed under
                  `prefers-reduced-motion: reduce`. */}
              {displayProgress !== null ? (
                <>
                  <progress
                    className="h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-1 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-all"
                    max={100}
                    value={displayProgress}
                    aria-label={`Uploading ${file?.name ?? 'file'}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {displayProgress}%
                    {chunkedProgress && (
                      <span>
                        {' '}
                        - Part {chunkedProgress.currentPart} of {chunkedProgress.totalParts}
                      </span>
                    )}
                  </p>
                </>
              ) : (
                <>
                  <progress
                    className="h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-1 [&::-webkit-progress-value]:bg-primary"
                    aria-label={`Uploading ${file?.name ?? 'file'}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    Uploading {file?.name ?? 'file'}...
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          {/* Cancel stays clickable during a direct upload now that
              handleClose aborts the in-flight controller. Disabled
              only while the chunked path's own cancel is mid-flight
              (the chunked-upload hook manages its own cancellation
              latency). */}
          <Button variant="secondary" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || !name.trim() || isUploading}>
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  )
}
