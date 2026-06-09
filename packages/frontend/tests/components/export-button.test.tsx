import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { ExportButton } from '../../src/components/features/results/export-button'
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
})
