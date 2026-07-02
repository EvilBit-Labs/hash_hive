import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  ExportButton,
  deriveDefaultScope,
  isScopeOptionDisabled,
  isPotfileFormatDisabled,
  reconcileFormat,
} from '../../src/components/features/results/export-button'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, renderWithProviders } from '../test-utils'

// The component is exercised end-to-end against the real
// `useExportResults` hook. Mocking the hook with `mock.module` would
// leak its replacement to any sibling test file that imports the SUT
// (bun:test's mock.module pollutes the module graph across files —
// see docs/solutions/conventions/bun-test-mock-module-import-order.md).
// Stubbing `fetch` + `URL.createObjectURL` keeps the surface tight
// and lets the real hook drive the button's `isPending` state.

let fetchMock: ReturnType<typeof mockFetch>

// Bound to satisfy the unbound-method lint rule (these methods don't
// touch `this` but the rule is conservative).
const originalCreate = URL.createObjectURL.bind(URL)
const originalRevoke = URL.revokeObjectURL.bind(URL)

beforeEach(() => {
  URL.createObjectURL = mock(() => 'blob:hashhive/fake') as typeof URL.createObjectURL
  URL.revokeObjectURL = mock(() => {}) as typeof URL.revokeObjectURL
  useUiStore.getState().setSelectedProject(7)
})

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
})

describe('ExportButton', () => {
  it('renders the default "Export CSV" label and is enabled when a project is selected', () => {
    renderWithProviders(<ExportButton filters={{}} />)
    const button = screen.getByRole('button', { name: 'Export CSV' })
    expect(button).toBeDefined()
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('fires the export request with the passed filters on click', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results.csv"',
        },
      },
    })

    renderWithProviders(<ExportButton filters={{ campaignId: 42, search: 'admin' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      expect(fetchMock!.mock.calls.length).toBe(1)
    })
    const url = String(fetchMock!.mock.calls[0]?.[0])
    expect(url).toContain('campaignId=42')
    expect(url).toContain('q=admin')
  })

  it('shows "Exporting..." text and is disabled while the mutation is pending', async () => {
    // Install a fetch that never resolves so the mutation stays pending
    // long enough to assert the loading state.
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch

    try {
      renderWithProviders(<ExportButton filters={{}} />)
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

      await waitFor(() => {
        const pendingButton = screen.getByRole('button', { name: 'Exporting...' })
        expect((pendingButton as HTMLButtonElement).disabled).toBe(true)
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('is disabled and does not fire fetch when no project is selected', () => {
    useUiStore.getState().setSelectedProject(null)
    fetchMock = mockFetch({})

    renderWithProviders(<ExportButton filters={{}} />)
    const button = screen.getByRole('button', { name: 'Export CSV' })
    expect((button as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(button)
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  it('renders the custom label when provided', () => {
    renderWithProviders(<ExportButton filters={{}} label="Download results" />)
    expect(screen.getByRole('button', { name: 'Download results' })).toBeDefined()
  })

  it('appends the Kbd character to the accessible name when shortcutKey is set', () => {
    renderWithProviders(<ExportButton filters={{}} shortcutKey="E" />)
    const button = screen.getByRole('button', { name: /Export CSV/ })
    // The visible Kbd char becomes part of the accessible name.
    expect(button.textContent ?? '').toContain('E')
  })

  it('clears the "Exported" label when a subsequent attempt errors', async () => {
    fetchMock = mockFetch({
      '/dashboard/results/export': {
        status: 200,
        body: 'csv-body',
        headers: { 'content-type': 'text/csv' },
      },
    })
    renderWithProviders(<ExportButton filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Exported' })).toBeDefined()
    })

    // Swap the mock to a failure for the second attempt.
    restoreFetch(fetchMock)
    fetchMock = mockFetch({
      '/dashboard/results/export': {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'boom' } },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Exported' }))

    await waitFor(() => {
      const alert = screen.queryByRole('alert')
      expect(alert).not.toBeNull()
    })
    // The button does NOT read "Exported" while the inline error is showing.
    expect(screen.queryByRole('button', { name: 'Exported' })).toBeNull()
  })

  it('renders scope, variant, and format combobox triggers', () => {
    renderWithProviders(<ExportButton filters={{}} />)
    expect(screen.getByRole('combobox', { name: 'Export scope' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Export variant' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: 'Export format' })).toBeDefined()
  })

  it('default export URL includes scope=project, variant=cracked-pairs, format=csv', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results.csv"',
        },
      },
    })

    renderWithProviders(<ExportButton filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      expect(fetchMock!.mock.calls.length).toBe(1)
    })
    const url = String(fetchMock!.mock.calls[0]?.[0])
    expect(url).toContain('scope=project')
    expect(url).toContain('variant=cracked-pairs')
    expect(url).toContain('format=csv')
  })

  it('sends scope=hash-list when hashListId is present in filters', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results.csv"',
        },
      },
    })

    renderWithProviders(<ExportButton filters={{ hashListId: 5 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      expect(fetchMock!.mock.calls.length).toBe(1)
    })
    const url = String(fetchMock!.mock.calls[0]?.[0])
    expect(url).toContain('scope=hash-list')
  })

  it('sends scope=campaign when campaignId is present (no hashListId)', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results.csv"',
        },
      },
    })

    renderWithProviders(<ExportButton filters={{ campaignId: 3 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      expect(fetchMock!.mock.calls.length).toBe(1)
    })
    const url = String(fetchMock!.mock.calls[0]?.[0])
    expect(url).toContain('scope=campaign')
  })

  it('shows the skip note when skippedCount > 0 in the response', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results.csv"',
          'x-export-skipped': '3',
        },
      },
    })

    renderWithProviders(<ExportButton filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      const alert = screen.queryByRole('alert')
      expect(alert).not.toBeNull()
      expect(alert?.textContent).toContain('3 rows skipped (hash type unknown)')
    })
  })

  it('does not show the skip note when skippedCount is 0', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/results/export': {
        status: 200,
        body: 'hash,plaintext\n',
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="results.csv"',
          'x-export-skipped': '0',
        },
      },
    })

    renderWithProviders(<ExportButton filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => {
      // Wait for the mutation to complete (button reverts to success ack).
      expect(screen.queryByRole('button', { name: 'Exported' })).not.toBeNull()
    })
    const alert = screen.queryByRole('alert')
    expect(alert).toBeNull()
  })
})

// ─── Pure decision helpers ───────────────────────────────────────────────────
// Radix Select open+click is not drivable in happy-dom (portal does not mount
// without a real browser). These unit tests cover the decision logic directly
// so each of the five spec scenarios is verified without DOM interaction.

describe('export option helpers', () => {
  describe('deriveDefaultScope', () => {
    it('returns hash-list when hashListId is present', () => {
      expect(deriveDefaultScope({ hashListId: 5 })).toBe('hash-list')
    })

    it('returns campaign when only campaignId is present', () => {
      expect(deriveDefaultScope({ campaignId: 3 })).toBe('campaign')
    })

    it('returns project when neither id is present', () => {
      expect(deriveDefaultScope({})).toBe('project')
    })

    it('prefers hash-list over campaign when both are present', () => {
      expect(deriveDefaultScope({ hashListId: 5, campaignId: 3 })).toBe('hash-list')
    })
  })

  describe('isScopeOptionDisabled', () => {
    it('disables hash-list option when hashListId is absent', () => {
      expect(isScopeOptionDisabled('hash-list', {})).toBe(true)
      expect(isScopeOptionDisabled('hash-list', { hashListId: 5 })).toBe(false)
    })

    it('disables campaign option when campaignId is absent', () => {
      expect(isScopeOptionDisabled('campaign', {})).toBe(true)
      expect(isScopeOptionDisabled('campaign', { campaignId: 3 })).toBe(false)
    })

    it('disables campaign option when hashListId is present (hash-list takes precedence)', () => {
      expect(isScopeOptionDisabled('campaign', { hashListId: 5, campaignId: 3 })).toBe(true)
    })

    it('disables project option when hashListId is present', () => {
      expect(isScopeOptionDisabled('project', { hashListId: 5 })).toBe(true)
      expect(isScopeOptionDisabled('project', {})).toBe(false)
    })
  })

  describe('isPotfileFormatDisabled', () => {
    it('returns true for plaintext-only variant', () => {
      expect(isPotfileFormatDisabled('plaintext-only')).toBe(true)
    })

    it('returns true for uncracked variant', () => {
      expect(isPotfileFormatDisabled('uncracked')).toBe(true)
    })

    it('returns false for cracked-pairs variant', () => {
      expect(isPotfileFormatDisabled('cracked-pairs')).toBe(false)
    })
  })

  describe('reconcileFormat', () => {
    it('resets hashcat-potfile to csv when variant is plaintext-only', () => {
      expect(reconcileFormat('plaintext-only', 'hashcat-potfile')).toBe('csv')
    })

    it('resets john-potfile to csv when variant is uncracked', () => {
      expect(reconcileFormat('uncracked', 'john-potfile')).toBe('csv')
    })

    it('keeps csv unchanged for any variant', () => {
      expect(reconcileFormat('plaintext-only', 'csv')).toBe('csv')
      expect(reconcileFormat('uncracked', 'csv')).toBe('csv')
      expect(reconcileFormat('cracked-pairs', 'csv')).toBe('csv')
    })

    it('keeps potfile format when variant is cracked-pairs', () => {
      expect(reconcileFormat('cracked-pairs', 'hashcat-potfile')).toBe('hashcat-potfile')
      expect(reconcileFormat('cracked-pairs', 'john-potfile')).toBe('john-potfile')
    })
  })
})
