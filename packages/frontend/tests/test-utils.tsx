/**
 * Test utilities wrapping Testing Library with app-level providers.
 *
 * Use `renderWithProviders()` instead of raw `render()` for components
 * that need React Query, Router, etc.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, type RenderOptions, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { resetAllStores } from './utils/store-reset';

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface WrapperProps {
  children: React.ReactNode;
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial route for the MemoryRouter. Defaults to "/". */
  initialRoute?: string;
  /** Optional QueryClient to use (e.g. for spying on invalidateQueries). */
  queryClient?: QueryClient;
}

function createAllProviders(initialRoute: string, queryClient: QueryClient) {
  return function AllProviders({ children }: WrapperProps) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialRoute]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

export function renderWithProviders(ui: ReactElement, options: RenderWithProvidersOptions = {}) {
  const { initialRoute = '/', queryClient, ...renderOptions } = options;
  const qc = queryClient ?? createTestQueryClient();
  return render(ui, {
    wrapper: createAllProviders(initialRoute, qc),
    ...renderOptions,
  });
}

interface RouteDefinition {
  path: string;
  element: ReactElement;
}

interface RenderWithRouterOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial route to navigate to. Defaults to first route path. */
  initialRoute?: string;
  /** Optional QueryClient to use. */
  queryClient?: QueryClient;
}

/**
 * Render a set of routes for testing navigation behavior.
 *
 * ```ts
 * renderWithRouter([
 *   { path: '/login', element: <LoginPage /> },
 *   { path: '/select-project', element: <div>Select Project</div> },
 *   { path: '/', element: <div>Dashboard</div> },
 * ], { initialRoute: '/login' });
 * ```
 */
export function renderWithRouter(routes: RouteDefinition[], options: RenderWithRouterOptions = {}) {
  const { initialRoute, queryClient, ...renderOptions } = options;
  const firstPath = routes[0]?.path ?? '/';
  const startRoute = initialRoute ?? firstPath;
  const qc = queryClient ?? createTestQueryClient();

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[startRoute]}>
        <Routes>
          {routes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    renderOptions
  );
}

/**
 * Combined cleanup helper. Call in `afterEach()` to clean up the DOM
 * and reset all Zustand stores between tests.
 */
export function cleanupAll() {
  cleanup();
  resetAllStores();
}

export { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
