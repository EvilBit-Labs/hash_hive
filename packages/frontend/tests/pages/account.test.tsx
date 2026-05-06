import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fireEvent } from '@testing-library/react';
import { AccountPage } from '../../src/pages/account';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, renderWithProviders, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

beforeEach(() => {
  fetchMock = mockFetch();
});

function setupRoutes(initialMetadata: {
  hasKey: boolean;
  prefix: string | null;
  lastUsedAt: string | null;
}) {
  const state = { metadata: initialMetadata };

  fetchMock = mockFetch();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = ((init?.method as string) ?? 'GET').toUpperCase();

    if (url.includes('/dashboard/auth/me/api-key')) {
      if (method === 'GET') {
        return new Response(JSON.stringify(state.metadata), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST') {
        const issued = {
          token: 'cst_42_abc-DEF_token',
          metadata: { hasKey: true, prefix: 'cst_42_…', lastUsedAt: null },
        };
        state.metadata = issued.metadata;
        return new Response(JSON.stringify(issued), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'DELETE') {
        state.metadata = { hasKey: false, prefix: null, lastUsedAt: null };
        return new Response(null, { status: 204 });
      }
    }

    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return state;
}

describe('AccountPage API key section', () => {
  it('shows the empty state and a Generate button when no key exists', async () => {
    setupRoutes({ hasKey: false, prefix: null, lastUsedAt: null });
    renderWithProviders(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByText(/You do not have an active API key/)).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /Generate API Key/ })).toBeDefined();
  });

  it('reveals the raw token exactly once after generation', async () => {
    setupRoutes({ hasKey: false, prefix: null, lastUsedAt: null });
    renderWithProviders(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate API Key/ })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate API Key/ }));

    await waitFor(() => {
      expect(screen.getByText('cst_42_abc-DEF_token')).toBeDefined();
    });
    expect(screen.getByText(/Save this token now/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /I've saved it/ }));
    await waitFor(() => {
      expect(screen.queryByText('cst_42_abc-DEF_token')).toBeNull();
    });
  });

  it('renders prefix and last-used time for an existing key', async () => {
    setupRoutes({
      hasKey: true,
      prefix: 'cst_42_…',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
    });
    renderWithProviders(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByText('cst_42_…')).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /Rotate/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /Revoke/ })).toBeDefined();
  });

  it('rotates after confirmation', async () => {
    setupRoutes({ hasKey: true, prefix: 'cst_42_…', lastUsedAt: null });
    renderWithProviders(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Rotate/ })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /Rotate/ }));
    await waitFor(() => {
      expect(screen.getByText(/Rotating issues a new API key/)).toBeDefined();
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^Rotate$/ })[1]);
    await waitFor(() => {
      expect(screen.getByText('cst_42_abc-DEF_token')).toBeDefined();
    });
  });

  it('wipes the rotated raw token from the DOM after acknowledgement', async () => {
    setupRoutes({ hasKey: true, prefix: 'cst_42_…', lastUsedAt: null });
    renderWithProviders(<AccountPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Rotate/ }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Rotate$/ })[1]);
    await waitFor(() => expect(screen.getByText('cst_42_abc-DEF_token')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /I've saved it/ }));
    await waitFor(() => {
      expect(screen.queryByText('cst_42_abc-DEF_token')).toBeNull();
    });
  });

  it('revokes after confirmation', async () => {
    setupRoutes({ hasKey: true, prefix: 'cst_42_…', lastUsedAt: null });
    renderWithProviders(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Revoke/ })).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /Revoke/ }));
    await waitFor(() => {
      expect(screen.getByText(/Revoking deletes the current API key/)).toBeDefined();
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^Revoke$/ })[1]);
    await waitFor(() => {
      expect(screen.getByText(/You do not have an active API key/)).toBeDefined();
    });
  });
});
