import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import {
  useCreateEnrollmentToken,
  useEnrollmentTokens,
  useRevokeEnrollmentToken,
} from '../../src/hooks/use-enrollment-tokens'
import { useUiStore } from '../../src/stores/ui'
import { mockFetch, restoreFetch } from '../mocks/fetch'
import { cleanupAll, createTestQueryClient, screen, waitFor } from '../test-utils'

let fetchMock: ReturnType<typeof mockFetch>

const META = {
  id: 1,
  projectId: 1,
  label: 'rack-3 rigs',
  isReusable: true,
  maxUses: 3,
  useCount: 0,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: '2026-06-18T00:00:00.000Z',
}

afterEach(() => {
  cleanupAll()
  if (fetchMock) restoreFetch(fetchMock)
})

function ListComponent() {
  const { data, isLoading } = useEnrollmentTokens()
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="count">{data ? String(data.length) : 'no-data'}</span>
      <span data-testid="first-label">{data?.[0]?.label ?? ''}</span>
    </div>
  )
}

function MintComponent() {
  const { mutate, data } = useCreateEnrollmentToken()
  return (
    <div>
      <button type="button" onClick={() => mutate({ isReusable: true, maxUses: 3 })}>
        mint
      </button>
      <span data-testid="token">{data?.token ?? 'none'}</span>
    </div>
  )
}

function RevokeComponent() {
  const { mutate, isSuccess } = useRevokeEnrollmentToken()
  return (
    <div>
      <button type="button" onClick={() => mutate(1)}>
        revoke
      </button>
      <span data-testid="done">{String(isSuccess)}</span>
    </div>
  )
}

function renderWithClient(node: React.ReactNode) {
  const qc = createTestQueryClient()
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('useEnrollmentTokens', () => {
  it('fetches the project tokens when a project is selected', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': { GET: { status: 200, body: { tokens: [META] } } },
    })
    useUiStore.setState({ selectedProjectId: 1 })
    renderWithClient(<ListComponent />)

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'))
    expect(screen.getByTestId('first-label').textContent).toBe('rack-3 rigs')
  })

  it('does not fetch when no project is selected', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': { GET: { status: 200, body: { tokens: [META] } } },
    })
    useUiStore.setState({ selectedProjectId: null })
    renderWithClient(<ListComponent />)

    await new Promise((r) => setTimeout(r, 80))
    expect(screen.getByTestId('count').textContent).toBe('no-data')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('useCreateEnrollmentToken', () => {
  it('posts the request and hands the raw token back to the caller', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens': {
        POST: { status: 201, body: { token: 'etk_1_brave-coral-otter-47', metadata: META } },
      },
    })
    useUiStore.setState({ selectedProjectId: 1 })
    renderWithClient(<MintComponent />)

    screen.getByText('mint').click()
    await waitFor(() =>
      expect(screen.getByTestId('token').textContent).toBe('etk_1_brave-coral-otter-47')
    )
  })
})

describe('useRevokeEnrollmentToken', () => {
  it('deletes the token by id', async () => {
    fetchMock = mockFetch({
      '/dashboard/enrollment-tokens/1': {
        DELETE: { status: 200, body: { ...META, revokedAt: '2026-06-18T01:00:00.000Z' } },
      },
    })
    useUiStore.setState({ selectedProjectId: 1 })
    renderWithClient(<RevokeComponent />)

    screen.getByText('revoke').click()
    await waitFor(() => expect(screen.getByTestId('done').textContent).toBe('true'))
  })
})
