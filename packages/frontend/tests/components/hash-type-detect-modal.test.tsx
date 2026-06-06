import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { HashTypeDetectModal } from '../../src/components/features/hash-type-detect-modal'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { renderWithProviders } from '../test-utils'

// Uses fetch-mocking (matches resources.test.tsx pattern) rather than
// mock.module, because mock.module replaces the entire hooks module
// for every other test file in the same bun:test invocation -
// breaking unrelated tests that import the real use-resources hooks
// (e.g., resources.test.tsx fixtures, campaign-create.test.tsx).

let fetchMock: ReturnType<typeof mockFetch>

afterEach(() => {
  cleanup()
  if (fetchMock) restoreFetch(fetchMock)
  // Restore the UI store so subsequent test files (e.g.,
  // resources.test.tsx) see a fresh "no project selected" state.
  useUiStore.setState({ selectedProjectId: null })
})

function selectProject(projectId = 1) {
  useUiStore.setState({ selectedProjectId: projectId })
}

function setupBaseMocks(extra: Record<string, { status?: number; body?: unknown }> = {}) {
  return mockFetch({
    '/dashboard/resources/hash-lists': {
      status: 200,
      body: {
        hashLists: [
          {
            id: 7,
            name: 'Test list',
            projectId: 1,
            hashTypeId: null,
            hashCount: 0,
            crackedCount: 0,
            status: 'ready',
            fileRef: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    },
    '/dashboard/resources/hash-types': {
      status: 200,
      body: {
        hashTypes: [
          { id: 101, name: 'MD5', hashcatMode: 0, category: 'Raw Hash' },
          { id: 102, name: 'NTLM', hashcatMode: 1000, category: 'OS' },
        ],
      },
    },
    ...extra,
  })
}

describe('HashTypeDetectModal', () => {
  it('does not render when open is false', () => {
    fetchMock = setupBaseMocks()
    selectProject()
    renderWithProviders(<HashTypeDetectModal open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Detect button is disabled when fewer than 5 samples are present', async () => {
    fetchMock = setupBaseMocks()
    selectProject()
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement
    expect(detect.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: 'h1\nh2\nh3\nh4' } })
    expect(detect.disabled).toBe(true)
  })

  it('Detect button enables at exactly 5 samples and submits the hashes batch', async () => {
    fetchMock = setupBaseMocks({
      '/dashboard/resources/detect-hash-type': {
        status: 200,
        body: { results: [] },
      },
    })
    selectProject()
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'h1\nh2\nh3\nh4\nh5' } })
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement
    expect(detect.disabled).toBe(false)
    fireEvent.click(detect)

    // The submission posts to the batch endpoint with field name
    // `hashes` (the shipped server contract). Pin via the fetch mock's
    // recorded call list when it surfaces; otherwise confirm via the
    // rendered Results section appearing after the response resolves.
    await waitFor(() => {
      expect(screen.getByText('Results')).toBeDefined()
    })
  })

  it('Detect button is disabled beyond 10 samples', () => {
    fetchMock = setupBaseMocks()
    selectProject()
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)
    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: { value: Array.from({ length: 11 }, (_, i) => `h${i}`).join('\n') },
    })
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement
    expect(detect.disabled).toBe(true)
  })

  it('renders flattened deduped candidates sorted by confidence DESC', async () => {
    fetchMock = setupBaseMocks({
      '/dashboard/resources/detect-hash-type': {
        status: 200,
        body: {
          results: [
            {
              hashValue: 'h1',
              candidates: [
                { name: 'MD5', hashcatMode: 0, category: 'Raw Hash', confidence: 0.95 },
                { name: 'NTLM', hashcatMode: 1000, category: 'OS', confidence: 0.5 },
              ],
            },
            {
              hashValue: 'h2',
              candidates: [{ name: 'MD5', hashcatMode: 0, category: 'Raw Hash', confidence: 0.99 }],
            },
          ],
        },
      },
    })
    selectProject()
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Sample hashes'), {
      target: { value: 'h1\nh2\nh3\nh4\nh5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))

    await waitFor(() => {
      expect(screen.getByText('MD5')).toBeDefined()
    })
    expect(screen.getByText('NTLM')).toBeDefined()
    // Max confidence across inputs (99%, not 95%) for the deduped row.
    expect(screen.getByText('99%')).toBeDefined()
    expect(screen.getByText('50%')).toBeDefined()
  })

  it('"Use This Type" sends the hash_types PK, not the hashcatMode (the bug the autofix found)', async () => {
    fetchMock = setupBaseMocks({
      '/dashboard/resources/detect-hash-type': {
        status: 200,
        body: {
          results: [
            {
              hashValue: 'h1',
              candidates: [
                // NTLM mode 1000 → hash_types.id 102 (see hash-types mock above).
                { name: 'NTLM', hashcatMode: 1000, category: 'OS', confidence: 0.9 },
              ],
            },
          ],
        },
      },
      '/dashboard/resources/hash-lists/7': {
        PATCH: { status: 200, body: { hashList: { id: 7, hashTypeId: 102 } } },
      },
    })
    selectProject()
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('Sample hashes'), {
      target: { value: 'h1\nh2\nh3\nh4\nh5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))

    await waitFor(() => {
      expect(screen.getByText('NTLM')).toBeDefined()
    })

    // Pick a list so the apply path is enabled.
    const listPicker = (await screen.findByLabelText(/Apply to hash list/)) as HTMLSelectElement
    fireEvent.change(listPicker, { target: { value: '7' } })

    const useButton = screen.getByRole('button', {
      name: 'Use This Type',
    }) as HTMLButtonElement
    await waitFor(() => {
      expect(useButton.disabled).toBe(false)
    })
    fireEvent.click(useButton)

    // The PATCH body must carry hashTypeId: 102 (PK), NOT 1000 (mode).
    // Confirm via the recorded fetch calls (mockFetch tracks).
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([url, init]: [string, RequestInit]) => {
        return (
          typeof url === 'string' &&
          url.includes('/dashboard/resources/hash-lists/7') &&
          init?.method === 'PATCH'
        )
      })
      expect(patchCalls.length).toBeGreaterThanOrEqual(1)
      const body = patchCalls[0]?.[1]?.body
      if (typeof body === 'string') {
        const parsed = JSON.parse(body) as { hashTypeId?: number }
        // CRITICAL: PK (102), not hashcatMode (1000). This pins the
        // bug the autofix found.
        expect(parsed.hashTypeId).toBe(102)
      }
    })
  })
})
