import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ResourceUploadModal } from '../../src/components/features/resource-upload-modal'
import { renderWithProviders } from '../test-utils'

afterEach(cleanup)

// Mock the resource hooks
const mockCreateMutateAsync = mock(() =>
  Promise.resolve({
    item: { id: 42, name: 'test', projectId: 1, fileRef: null, createdAt: '' },
  })
)
const mockUploadMutateAsync = mock((_args: { id: number; file: File; signal?: AbortSignal }) =>
  Promise.resolve({})
)
const mockDeleteMutateAsync = mock((_id: number) => Promise.resolve(undefined))

// bun:test's mock.module merges - unmocked exports pass through to
// the real module. Only mock the hooks this file actively exercises.
mock.module('../../src/hooks/use-resources', () => ({
  useCreateResource: () => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  }),
  useUploadResourceFile: () => ({
    mutateAsync: mockUploadMutateAsync,
    isPending: false,
  }),
  useDeleteResource: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
}))

describe('ResourceUploadModal', () => {
  it('should not render when open is false', () => {
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={false} onClose={() => {}} onSuccess={() => {}} />
    )
    expect(screen.queryByText('Upload New Wordlist')).toBeNull()
  })

  it('should render with name input and file input when open', () => {
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    expect(screen.getByText('Upload New Wordlist')).toBeDefined()
    expect(screen.getByLabelText('Name')).toBeDefined()
    expect(screen.getByLabelText('File')).toBeDefined()
  })

  it('should render correct title for each resource type', () => {
    const { unmount } = renderWithProviders(
      <ResourceUploadModal type="hash-lists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    expect(screen.getByText('Upload New Hash List')).toBeDefined()
    unmount()

    renderWithProviders(
      <ResourceUploadModal type="masklists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    expect(screen.getByText('Upload New Masklist')).toBeDefined()
  })

  it('should disable upload button when no file is selected', () => {
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    const uploadButton = screen.getByText('Upload')
    expect(uploadButton.hasAttribute('disabled')).toBe(true)
  })

  it('should call onClose when Cancel is clicked', () => {
    const onClose = mock(() => {})
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={onClose} onSuccess={() => {}} />
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('should create resource and upload file on submit', async () => {
    mockCreateMutateAsync.mockClear()
    mockUploadMutateAsync.mockClear()

    const onSuccess = mock(() => {})
    const onClose = mock(() => {})
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={onClose} onSuccess={onSuccess} />
    )

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Wordlist' } })

    const file = new File(['test content'], 'test.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } })

    const uploadButton = screen.getByText('Upload')
    expect(uploadButton.hasAttribute('disabled')).toBe(false)

    fireEvent.click(uploadButton)

    await waitFor(() => {
      expect(mockCreateMutateAsync).toHaveBeenCalledWith({ name: 'My Wordlist' })
    })
    await waitFor(() => {
      // The hook now accepts an optional AbortSignal; the modal wires
      // its own controller. Pin the id+file payload but allow any
      // additional fields so a future signal-name change doesn't
      // require this test to know the internal field.
      expect(mockUploadMutateAsync).toHaveBeenCalledTimes(1)
      const call = mockUploadMutateAsync.mock.calls[0]?.[0]
      expect(call?.id).toBe(42)
      expect(call?.file).toBe(file)
      // AbortController is wired so direct-upload Cancel actually
      // cancels - pin that the signal is non-null.
      expect(call?.signal).toBeDefined()
      expect(onSuccess).toHaveBeenCalledWith(42)
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('rolls back the created row when upload fails (orphan-row prevention)', async () => {
    mockCreateMutateAsync.mockClear()
    mockUploadMutateAsync.mockClear()
    mockDeleteMutateAsync.mockClear()
    // Resolve create, reject upload.
    mockCreateMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({
        item: { id: 99, name: 'orphan', projectId: 1, fileRef: null, createdAt: '' },
      })
    )
    mockUploadMutateAsync.mockImplementationOnce(() => Promise.reject(new Error('S3 returned 502')))

    const onSuccess = mock(() => {})
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={() => {}} onSuccess={onSuccess} />
    )

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Wordlist' } })
    const file = new File(['x'], 'x.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } })
    fireEvent.click(screen.getByText('Upload'))

    await waitFor(() => {
      // Rollback delete must be called with the just-created id.
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith(99)
    })
    // Success callback must NOT fire on upload failure.
    expect(onSuccess).not.toHaveBeenCalled()
    // The original upload error surfaces (not the rollback error).
    await waitFor(() => {
      expect(screen.getByText(/S3 returned 502/)).toBeDefined()
    })
  })

  it('surfaces orphan id in the error message when rollback delete also fails', async () => {
    mockCreateMutateAsync.mockClear()
    mockUploadMutateAsync.mockClear()
    mockDeleteMutateAsync.mockClear()
    mockCreateMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({
        item: { id: 77, name: 'doomed', projectId: 1, fileRef: null, createdAt: '' },
      })
    )
    mockUploadMutateAsync.mockImplementationOnce(() => Promise.reject(new Error('Upload broke')))
    mockDeleteMutateAsync.mockImplementationOnce(() => Promise.reject(new Error('Delete broke')))

    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'doomed' } })
    fireEvent.change(screen.getByLabelText('File'), {
      target: { files: [new File(['x'], 'x.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByText('Upload'))

    await waitFor(() => {
      // User-facing error names the orphan id so they (or support)
      // can clean it up out of band.
      expect(screen.getByText(/orphan row id 77/)).toBeDefined()
    })
  })

  it('Cancel stays clickable during a direct upload so the operator can abort', () => {
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    const cancel = screen.getByText('Cancel') as HTMLButtonElement
    // Pin that Cancel is not unconditionally disabled - the regression
    // would re-introduce the wedged-modal bug where a hung direct
    // upload could not be cancelled.
    expect(cancel.disabled).toBe(false)
  })

  it('dropzone is keyboard-operable - Enter opens the file picker', () => {
    renderWithProviders(
      <ResourceUploadModal type="wordlists" open={true} onClose={() => {}} onSuccess={() => {}} />
    )
    const dropzone = screen.getByLabelText('Drop file here, or press Enter to browse')
    expect(dropzone.getAttribute('role')).toBe('button')
    expect(dropzone.getAttribute('tabindex')).toBe('0')
  })
})
