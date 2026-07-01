/**
 * Tests for HashImportModal (U9).
 *
 * Uses mockFetch (API layer) rather than mock.module on use-hash-lists so
 * that the real useHashListSummaries hook runs through its own code path and
 * the mock does not leak into the standalone use-hash-lists hook tests.
 *
 * The import mutation (use-hash-import) is mocked at module scope because
 * there is no separate hook test file for it that could be polluted.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { HashImportModal } from '../../src/components/features/hash-import-modal'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { createTestQueryClient, renderWithProviders } from '../test-utils'

// ─── Mock the import mutation ─────────────────────────────────────────────────
// Safe to mock at module scope: no standalone use-hash-import hook test file.

const mockImportMutateAsync = mock(() =>
  Promise.resolve({ matchedInList: 10, crackedInList: 7, skipped: 2 })
)
const mockImportReset = mock(() => {})

mock.module('../../src/hooks/use-hash-import', () => ({
  useImportPrecracked: () => ({
    mutateAsync: mockImportMutateAsync,
    isPending: false,
    reset: mockImportReset,
  }),
}))

// ─── Shared fetch mock config ─────────────────────────────────────────────────

const HASH_LISTS_RESPONSE = {
  hashLists: [
    { id: 1, name: 'Rockyou', hashTypeId: null, hashCount: 1000, crackedCount: 200 },
    { id: 2, name: 'NTLM dump', hashTypeId: 1000, hashCount: 500, crackedCount: 50 },
  ],
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof mockFetch>

beforeEach(() => {
  useUiStore.setState({ selectedProjectId: 1 })
  fetchMock = mockFetch({
    '/api/v1/dashboard/hash-lists': { status: 200, body: HASH_LISTS_RESPONSE },
    '/api/v1/dashboard/hashes/hash-lists': {
      status: 202,
      body: { matchedInList: 0, crackedInList: 0, skipped: 0 },
    },
  })
})

afterEach(() => {
  cleanup()
  restoreFetch(fetchMock)
  useUiStore.setState({ selectedProjectId: null })
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFile(content = 'hash1:plain1\nhash2:plain2') {
  return new File([content], 'pairs.txt', { type: 'text/plain' })
}

describe('HashImportModal', () => {
  it('does not render content when closed', () => {
    renderWithProviders(<HashImportModal open={false} onClose={() => {}} />)
    expect(screen.queryByText('Import Pre-cracked Hashes')).toBeNull()
  })

  it('renders the title and both selectors when open', () => {
    renderWithProviders(<HashImportModal open={true} onClose={() => {}} />)
    expect(screen.getByText('Import Pre-cracked Hashes')).toBeDefined()
    expect(screen.getByLabelText('Target hash list')).toBeDefined()
    expect(screen.getByLabelText('File format')).toBeDefined()
  })

  it('does not render a name field', () => {
    renderWithProviders(<HashImportModal open={true} onClose={() => {}} />)
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.queryByPlaceholderText(/name/i)).toBeNull()
  })

  it('disables the Import button when no target list is selected', () => {
    renderWithProviders(<HashImportModal open={true} onClose={() => {}} />)
    const file = makeFile()
    fireEvent.change(screen.getByLabelText('Import file'), { target: { files: [file] } })
    const btn = screen.getByText('Import') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('disables the Import button when no file is selected (even with a list)', () => {
    renderWithProviders(
      <HashImportModal open={true} onClose={() => {}} preselectedHashListId={1} />
    )
    const btn = screen.getByText('Import') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('enables Import when a target list and file are both provided', () => {
    renderWithProviders(
      <HashImportModal open={true} onClose={() => {}} preselectedHashListId={1} />
    )
    fireEvent.change(screen.getByLabelText('Import file'), {
      target: { files: [makeFile()] },
    })
    const btn = screen.getByText('Import') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('transitions to summary phase on success and shows matched/cracked/skipped', async () => {
    mockImportMutateAsync.mockClear()
    mockImportMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ matchedInList: 10, crackedInList: 7, skipped: 2 })
    )

    renderWithProviders(
      <HashImportModal open={true} onClose={() => {}} preselectedHashListId={1} />
    )
    fireEvent.change(screen.getByLabelText('Import file'), {
      target: { files: [makeFile()] },
    })
    fireEvent.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(screen.getByText('Import queued')).toBeDefined()
    })

    expect(screen.getByText('Matched in list')).toBeDefined()
    expect(screen.getByText('Cracked')).toBeDefined()
    expect(screen.getByText('Skipped')).toBeDefined()
    expect(screen.getByText('10')).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()
    expect(screen.getByText('2')).toBeDefined()
  })

  it('surfaces an error and stays in input phase when import fails', async () => {
    mockImportMutateAsync.mockClear()
    mockImportMutateAsync.mockImplementationOnce(() =>
      Promise.reject(new Error('Service unavailable'))
    )

    renderWithProviders(
      <HashImportModal open={true} onClose={() => {}} preselectedHashListId={1} />
    )
    fireEvent.change(screen.getByLabelText('Import file'), {
      target: { files: [makeFile()] },
    })
    fireEvent.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(screen.getByText(/Service unavailable/)).toBeDefined()
    })

    // Must stay on the input phase — no summary heading, no Close button.
    expect(screen.queryByText('Import queued')).toBeNull()
    expect(screen.getByText('Import Pre-cracked Hashes')).toBeDefined()
  })

  it('calls onClose and invalidates hash-list-items + results on summary Close', async () => {
    mockImportMutateAsync.mockClear()
    mockImportMutateAsync.mockImplementationOnce(() =>
      Promise.resolve({ matchedInList: 3, crackedInList: 1, skipped: 0 })
    )

    const qc = createTestQueryClient()
    const invalidateSpy = spyOn(qc, 'invalidateQueries')
    const onClose = mock(() => {})

    renderWithProviders(
      <HashImportModal open={true} onClose={onClose} preselectedHashListId={2} />,
      { queryClient: qc }
    )
    fireEvent.change(screen.getByLabelText('Import file'), {
      target: { files: [makeFile()] },
    })
    fireEvent.click(screen.getByText('Import'))

    await waitFor(() => {
      expect(screen.getByText('Import queued')).toBeDefined()
    })

    // Click the footer Close button (only Close button — no X button since showCloseButton=false).
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalled()
    const calledKeys = invalidateSpy.mock.calls.map(
      (args) => (args[0] as { queryKey: unknown[] }).queryKey
    )
    expect(calledKeys.some((k) => k[0] === 'hash-list-items')).toBe(true)
    expect(calledKeys.some((k) => k[0] === 'results')).toBe(true)
  })

  it('calls onClose when Cancel is clicked', () => {
    const onClose = mock(() => {})
    renderWithProviders(<HashImportModal open={true} onClose={onClose} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('dropzone is keyboard-operable', () => {
    renderWithProviders(<HashImportModal open={true} onClose={() => {}} />)
    const dropzone = screen.getByLabelText('Drop file here, or press Enter to browse')
    expect(dropzone.getAttribute('role')).toBe('button')
    expect(dropzone.getAttribute('tabindex')).toBe('0')
  })

  it('preselects the hash list so Import enables immediately after a file is added', () => {
    renderWithProviders(
      <HashImportModal open={true} onClose={() => {}} preselectedHashListId={2} />
    )
    // Without a file: disabled.
    expect((screen.getByText('Import') as HTMLButtonElement).disabled).toBe(true)
    // With a file: enabled (preselected id satisfied the list-gate).
    fireEvent.change(screen.getByLabelText('Import file'), {
      target: { files: [makeFile()] },
    })
    expect((screen.getByText('Import') as HTMLButtonElement).disabled).toBe(false)
  })
})
