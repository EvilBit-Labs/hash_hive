import { afterEach, describe, expect, it } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProtectedRoute } from '../../src/components/features/protected-route';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { cleanupAll, createTestQueryClient, screen } from '../test-utils';

afterEach(cleanupAll);

/**
 * Renders a route tree with ProtectedRoute as a layout route wrapping child content.
 */
function renderProtectedTree(initialRoute = '/') {
  const qc = createTestQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route index element={<div>Protected Content</div>} />
          </Route>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/select-project" element={<div>Select Project</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ProtectedRoute', () => {
  it('redirects to /login when not authenticated', () => {
    useAuthStore.setState({ isAuthenticated: false, isLoading: false, user: null });

    renderProtectedTree('/');

    expect(screen.getByText('Login Page')).toBeDefined();
  });

  it('redirects to /select-project when authenticated but no project selected', () => {
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      user: {
        id: 1,
        email: 'admin@hashhive.local',
        name: 'Admin',
        projects: [{ projectId: 1, projectName: 'Project 1', roles: ['admin'] }],
      },
    });
    useUiStore.setState({ selectedProjectId: null });

    renderProtectedTree('/');

    expect(screen.getByText('Select Project')).toBeDefined();
  });

  it('renders outlet when authenticated and project selected', () => {
    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      user: {
        id: 1,
        email: 'admin@hashhive.local',
        name: 'Admin',
        projects: [{ projectId: 1, projectName: 'Project 1', roles: ['admin'] }],
      },
    });
    useUiStore.setState({ selectedProjectId: 1 });

    renderProtectedTree('/');

    expect(screen.getByText('Protected Content')).toBeDefined();
  });

  it('shows loading state while auth is loading', () => {
    useAuthStore.setState({ isLoading: true, isAuthenticated: false, user: null });

    renderProtectedTree('/');

    expect(screen.getByText('Loading...')).toBeDefined();
  });
});
