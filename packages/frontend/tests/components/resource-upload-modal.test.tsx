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
const mockUploadMutateAsync = mock(() => Promise.resolve({}))

mock.module('../../src/hooks/use-resources', () => ({
  useCreateResource: () => ({
    mutateAsync: mockCreateMutateAsync,
    isPending: false,
  }),
  useUploadResourceFile: () => ({
    mutateAsync: mockUploadMutateAsync,
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
      expect(mockUploadMutateAsync).toHaveBeenCalledWith({ id: 42, file })
      expect(onSuccess).toHaveBeenCalledWith(42)
      expect(onClose).toHaveBeenCalled()
    })
  })
})
