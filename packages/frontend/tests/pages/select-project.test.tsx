import { afterEach, describe, expect, it } from 'bun:test';
import { SelectProjectPage } from '../../src/pages/select-project';
import { useAuthStore } from '../../src/stores/auth';
import { useUiStore } from '../../src/stores/ui';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, fireEvent, renderWithRouter, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

function setAuthenticatedUser(projectCount: number) {
  const projects = Array.from({ length: projectCount }, (_, i) => ({
    projectId: i + 1,
    projectName: `Project ${i + 1}`,
    roles: ['admin'],
  }));

  useAuthStore.setState({
    user: {
      id: 1,
      email: 'admin@hashhive.local',
      name: 'Admin User',
      projects,
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe('SelectProjectPage', () => {
  it('redirects to /login when not authenticated', () => {
    fetchMock = mockFetch();
    // Auth store defaults to isLoading: true, so set it to false + not authenticated
    useAuthStore.setState({ isLoading: false, isAuthenticated: false, user: null });

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/login', element: <div>Login Page</div> },
      ],
      { initialRoute: '/select-project' }
    );

    expect(screen.getByText('Login Page')).toBeDefined();
  });

  it('redirects to / when project already selected', () => {
    fetchMock = mockFetch();
    setAuthenticatedUser(2);
    useUiStore.setState({ selectedProjectId: 1 });

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/select-project' }
    );

    expect(screen.getByText('Dashboard Home')).toBeDefined();
  });

  it('renders project list for authenticated user', () => {
    fetchMock = mockFetch();
    setAuthenticatedUser(2);

    renderWithRouter([{ path: '/select-project', element: <SelectProjectPage /> }], {
      initialRoute: '/select-project',
    });

    expect(screen.getByText('Select Project')).toBeDefined();
    expect(screen.getByText('Project 1')).toBeDefined();
    expect(screen.getByText('Project 2')).toBeDefined();
    // Roles should be displayed
    const roleTexts = screen.getAllByText('admin');
    expect(roleTexts.length).toBe(2);
  });

  it('selects project and redirects to /', async () => {
    fetchMock = mockFetch({
      '/dashboard/projects/select': { status: 200, body: undefined },
    });
    setAuthenticatedUser(2);

    renderWithRouter(
      [
        { path: '/select-project', element: <SelectProjectPage /> },
        { path: '/', element: <div>Dashboard Home</div> },
      ],
      { initialRoute: '/select-project' }
    );

    fireEvent.click(screen.getByText('Project 1'));

    await waitFor(() => {
      expect(useUiStore.getState().selectedProjectId).toBe(1);
    });
  });

  it('shows empty state when no projects', () => {
    fetchMock = mockFetch();
    setAuthenticatedUser(0);

    renderWithRouter([{ path: '/select-project', element: <SelectProjectPage /> }], {
      initialRoute: '/select-project',
    });

    expect(screen.getByText('No projects available. Contact an administrator.')).toBeDefined();
  });
});
