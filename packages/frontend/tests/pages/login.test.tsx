import { afterEach, describe, expect, it } from 'bun:test';
import { LoginPage } from '../../src/pages/login';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { mockMeResponse } from '../fixtures/api-responses';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

describe('LoginPage', () => {
  it('renders login form', () => {
    fetchMock = mockFetch();
    renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' });

    expect(screen.getByText('HashHive')).toBeDefined();
    expect(screen.getByLabelText('Email')).toBeDefined();
    expect(screen.getByLabelText('Password')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDefined();
  });

  it('shows error on invalid credentials', async () => {
    fetchMock = mockFetch({
      '/api/auth/sign-in/email': {
        status: 400,
        body: { message: 'Invalid email or password' },
      },
    });

    renderWithRouter([{ path: '/login', element: <LoginPage /> }], { initialRoute: '/login' });

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'bad@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrongpassword' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(screen.getByText('Invalid email or password')).toBeDefined();
    });
  });

  it('redirects to /select-project when multiple projects', async () => {
    const meResponse = mockMeResponse({ projectCount: 2 });
    fetchMock = mockFetch({
      '/api/auth/sign-in/email': { status: 200, body: { user: { id: 1 } } },
      '/dashboard/auth/me': { status: 200, body: meResponse },
    });

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard</div> },
      ],
      { initialRoute: '/login' }
    );

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(screen.getByText('Select Project Page')).toBeDefined();
    });
  });

  it('auto-selects project and redirects to / when single project', async () => {
    const meResponse = mockMeResponse({ projectCount: 1 });
    fetchMock = mockFetch({
      '/api/auth/sign-in/email': { status: 200, body: { user: { id: 1 } } },
      '/dashboard/auth/me': { status: 200, body: meResponse },
    });

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/select-project', element: <div>Select Project Page</div> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    );

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'admin@hashhive.local' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(screen.getByText('Dashboard Home')).toBeDefined();
    });

    expect(useUiStore.getState().selectedProjectId).toBe(1);
  });

  it('already authenticated user redirects to /', () => {
    fetchMock = mockFetch();
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

    renderWithRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/login' }
    );

    // Should immediately redirect - no login form visible
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByText('Dashboard Home')).toBeDefined();
  });
});
