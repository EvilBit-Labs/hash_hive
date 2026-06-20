import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'bun:test'

import { EnrollmentTokenManager } from '../../src/components/features/enrollment-token-manager'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import {
  cleanupAll,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
} from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

const activeToken = {
  id: 1,
  projectId: 1,
  label: 'rack-3 rigs',
  isReusable: true,
  maxUses: 3,
  useCount: 1,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-06-18T00:00:00.000Z',
}
const revokedToken = {
  ...activeToken,
  id: 2,
  label: 'old token',
  revokedAt: '2026-06-17T00:00:00.000Z',
}

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function renderManager() {
  useUiStore.setState({ selectedProjectId: 1 })
  const qc = createTestQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <EnrollmentTokenManager serverOrigin="https://hashhive.local" />
    </QueryClientProvider>
  )
}

describe('EnrollmentTokenManager', () => {
  it('lists tokens and shows Revoke only for active ones', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': {
        GET: { status: 200, body: { tokens: [activeToken, revokedToken] } },
      },
    })
    renderManager()

    await waitFor(() => expect(screen.getByText('rack-3 rigs')).toBeTruthy())
    expect(screen.getByText('old token')).toBeTruthy()
    // Status renders via StatusBadge (lowercase text, capitalized in CSS).
    expect(screen.getByText('revoked')).toBeTruthy()
    // One active token -> exactly one Revoke button.
    expect(screen.getAllByText('Revoke')).toHaveLength(1)
  })

  it('opens the mint form when the generate button is clicked', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': { GET: { status: 200, body: { tokens: [] } } },
    })
    renderManager()

    await waitFor(() => expect(screen.getByText('Generate enrollment token')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate enrollment token'))
    expect(screen.getByPlaceholderText('e.g. rack-3 rigs')).toBeTruthy()
    expect(screen.getByText('One-time')).toBeTruthy()
    expect(screen.getByText('Reusable')).toBeTruthy()
  })

  it('reveals the minted token and the agent command once', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': {
        GET: { status: 200, body: { tokens: [] } },
        POST: {
          status: 201,
          body: { token: 'etk_1_brave-coral-otter-47', metadata: activeToken },
        },
      },
    })
    renderManager()

    await waitFor(() => expect(screen.getByText('Generate enrollment token')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate enrollment token'))
    fireEvent.click(screen.getByText('Generate token'))

    await waitFor(() => expect(screen.getByText('etk_1_brave-coral-otter-47')).toBeTruthy())
    // The operator-facing command references the documented enroll invocation.
    expect(screen.getByText(/hashhive-agent enroll/)).toBeTruthy()
    expect(screen.getByText(/--token etk_1_brave-coral-otter-47/)).toBeTruthy()
  })

  it('clears the revealed token after Done is clicked', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': {
        GET: { status: 200, body: { tokens: [] } },
        POST: {
          status: 201,
          body: { token: 'etk_1_brave-coral-otter-47', metadata: activeToken },
        },
      },
    })
    renderManager()

    // Mint a token so the reveal block appears.
    await waitFor(() => expect(screen.getByText('Generate enrollment token')).toBeTruthy())
    fireEvent.click(screen.getByText('Generate enrollment token'))
    fireEvent.click(screen.getByText('Generate token'))

    // Wait for the reveal block to render with the raw token.
    await waitFor(() => expect(screen.getByText('etk_1_brave-coral-otter-47')).toBeTruthy())

    // Dismiss the reveal.
    fireEvent.click(screen.getByText('Done'))

    // The exact token string (in its standalone <code> block) must be gone.
    // Use queryByText with the exact string — not a regex — to avoid matching
    // the command block that also embeds the token value.
    await waitFor(() => expect(screen.queryByText('etk_1_brave-coral-otter-47')).toBeNull())
    // The primary generate button must be restored.
    expect(screen.getByText('Generate enrollment token')).toBeTruthy()
  })
})
