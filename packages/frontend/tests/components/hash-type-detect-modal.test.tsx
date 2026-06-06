import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { HashTypeDetectModal } from '../../src/components/features/hash-type-detect-modal'
import { renderWithProviders } from '../test-utils'

afterEach(cleanup)

// Mock hooks: useHashLists provides the list-picker source, useHashTypes
// provides the hashcatMode→id PK lookup (the bug the autofix fixed —
// without this lookup, "Use This Type" would send mode-as-id), and the
// mutations are spied so we can assert request shape.

const mockDetectMutate = mock((_samples: string[], _opts?: unknown) => {})
const mockSetTypeMutate = mock((_input: { hashTypeId: number }, _opts?: unknown) => {})
const mockDetectReset = mock(() => {})

let detectData: unknown = null
let detectIsPending = false
let setTypeIsPending = false

mock.module('../../src/hooks/use-resources', () => ({
  useHashLists: () => ({
    data: {
      hashLists: [
        { id: 7, name: 'Test list', projectId: 1, status: 'ready' },
        { id: 8, name: 'Another list', projectId: 1, status: 'ready' },
      ],
    },
    isLoading: false,
  }),
  useHashTypes: () => ({
    data: {
      hashTypes: [
        { id: 101, name: 'MD5', hashcatMode: 0, category: 'Raw Hash' },
        { id: 102, name: 'NTLM', hashcatMode: 1000, category: 'OS' },
        // Intentionally omit mode 99999 to exercise the not-registered branch.
      ],
    },
  }),
  useDetectHashTypeBatch: () => ({
    mutate: mockDetectMutate,
    reset: mockDetectReset,
    data: detectData,
    isPending: detectIsPending,
  }),
  useSetHashListType: (_hashListId: number) => ({
    mutate: mockSetTypeMutate,
    isPending: setTypeIsPending,
  }),
}))

describe('HashTypeDetectModal', () => {
  afterEach(() => {
    mockDetectMutate.mockReset()
    mockSetTypeMutate.mockReset()
    mockDetectReset.mockReset()
    detectData = null
    detectIsPending = false
    setTypeIsPending = false
  })

  it('does not render when open is false', () => {
    renderWithProviders(<HashTypeDetectModal open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Detect button is disabled when fewer than 5 samples are present', () => {
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement

    expect(detect.disabled).toBe(true)
    fireEvent.change(textarea, { target: { value: 'h1\nh2\nh3\nh4' } })
    expect(detect.disabled).toBe(true)
  })

  it('Detect button enables at exactly 5 samples and submits the hashes batch', () => {
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: { value: 'h1\nh2\nh3\nh4\nh5' },
    })
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement
    expect(detect.disabled).toBe(false)

    fireEvent.click(detect)

    expect(mockDetectMutate).toHaveBeenCalledTimes(1)
    const samples = mockDetectMutate.mock.calls[0]?.[0]
    expect(samples).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
  })

  it('Detect button is disabled beyond 10 samples', () => {
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)
    const textarea = screen.getByLabelText('Sample hashes') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: { value: Array.from({ length: 11 }, (_, i) => `h${i}`).join('\n') },
    })
    const detect = screen.getByRole('button', { name: 'Detect' }) as HTMLButtonElement
    expect(detect.disabled).toBe(true)
  })

  it('renders flattened deduped candidates sorted by confidence DESC', async () => {
    detectData = {
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
    }

    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('MD5')).toBeDefined()
    })
    // Both candidates surface despite the per-input duplication of MD5.
    expect(screen.getByText('NTLM')).toBeDefined()
    // Max confidence is what shows (99%, not 95%) — the dedup keeps
    // the highest seen across inputs.
    expect(screen.getByText('99%')).toBeDefined()
    expect(screen.getByText('50%')).toBeDefined()
  })

  it('"Use This Type" sends the hash_types PK, not the hashcatMode', () => {
    detectData = {
      results: [
        {
          hashValue: 'h1',
          candidates: [
            // NTLM mode 1000 → hash_types.id 102 (see mock above).
            { name: 'NTLM', hashcatMode: 1000, category: 'OS', confidence: 0.9 },
          ],
        },
      ],
    }

    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    // Pick a list so the apply path is enabled.
    const listPicker = screen.getByLabelText(/Apply to hash list/) as HTMLSelectElement
    fireEvent.change(listPicker, { target: { value: '7' } })

    const useButton = screen.getByRole('button', { name: 'Use This Type' }) as HTMLButtonElement
    expect(useButton.disabled).toBe(false)
    fireEvent.click(useButton)

    expect(mockSetTypeMutate).toHaveBeenCalledTimes(1)
    const payload = mockSetTypeMutate.mock.calls[0]?.[0]
    // Critical: payload.hashTypeId is 102 (the PK), NOT 1000 (the
    // hashcatMode). This is the bug the autofix pass found and fixed.
    expect(payload?.hashTypeId).toBe(102)
  })

  it('"Use This Type" is disabled when no list is selected', () => {
    detectData = {
      results: [
        {
          hashValue: 'h1',
          candidates: [{ name: 'NTLM', hashcatMode: 1000, category: 'OS', confidence: 0.9 }],
        },
      ],
    }

    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const useButton = screen.getByRole('button', { name: 'Use This Type' }) as HTMLButtonElement
    expect(useButton.disabled).toBe(true)
  })

  it('surfaces an inline error when the chosen hashcatMode has no registered hash_types row', async () => {
    detectData = {
      results: [
        {
          hashValue: 'h1',
          candidates: [
            // Mode 99999 is intentionally not in the useHashTypes mock.
            { name: 'Unknown', hashcatMode: 99999, category: '???', confidence: 0.8 },
          ],
        },
      ],
    }

    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const listPicker = screen.getByLabelText(/Apply to hash list/) as HTMLSelectElement
    fireEvent.change(listPicker, { target: { value: '7' } })

    const useButton = screen.getByRole('button', { name: 'Use This Type' }) as HTMLButtonElement
    fireEvent.click(useButton)

    // The mutation should NOT fire — the modal short-circuits with an
    // inline error before reaching the PATCH route.
    expect(mockSetTypeMutate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText(/not registered server-side/)).toBeDefined()
    })
  })

  it('Close button is disabled while detect is pending', () => {
    detectIsPending = true
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const close = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement
    expect(close.disabled).toBe(true)
  })

  it('Close button is disabled while set-type is pending', () => {
    setTypeIsPending = true
    renderWithProviders(<HashTypeDetectModal open onClose={() => {}} />)

    const close = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement
    expect(close.disabled).toBe(true)
  })
})
