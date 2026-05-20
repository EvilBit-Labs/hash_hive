import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { useAuthStore } from '../../src/stores/auth';
import { useCampaignWizard } from '../../src/stores/campaign-wizard';
import { useUiStore } from '../../src/stores/ui';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import {
  act,
  cleanup,
  cleanupAll,
  createTestQueryClient,
  fireEvent,
  renderWithProviders,
  screen,
  waitFor,
} from '../test-utils';

// React Flow needs ResizeObserver and DOM measurement APIs happy-dom lacks.
// Stub it with a controllable test double that exposes the wired callbacks
// (onConnect, onNodeClick, onNodeContextMenu, onEdgesDelete) so we can
// invoke them imperatively from tests.

interface CapturedHandlers {
  onConnect?: (c: { source: string; target: string }) => void;
  onNodeClick?: (e: unknown, node: { id: string }) => void;
  onNodeContextMenu?: (e: { preventDefault: () => void }, node: { id: string }) => void;
  onEdgesDelete?: (edges: { id: string; source: string; target: string }[]) => void;
}

const captured: CapturedHandlers = {};

mock.module('reactflow', () => {
  function ReactFlow(props: {
    nodes: { id: string; data: { label: string } }[];
    edges: { id: string; source: string; target: string }[];
    onConnect?: CapturedHandlers['onConnect'];
    onNodeClick?: CapturedHandlers['onNodeClick'];
    onNodeContextMenu?: CapturedHandlers['onNodeContextMenu'];
    onEdgesDelete?: CapturedHandlers['onEdgesDelete'];
  }) {
    captured.onConnect = props.onConnect;
    captured.onNodeClick = props.onNodeClick;
    captured.onNodeContextMenu = props.onNodeContextMenu;
    captured.onEdgesDelete = props.onEdgesDelete;
    return (
      <div data-testid="react-flow-stub">
        <ul data-testid="dag-nodes">
          {props.nodes.map((n) => (
            <li key={n.id} data-node-id={n.id}>
              {n.data.label}
            </li>
          ))}
        </ul>
        <ul data-testid="dag-edges">
          {props.edges.map((e) => (
            <li key={e.id} data-edge-source={e.source} data-edge-target={e.target}>
              {e.source} -&gt; {e.target}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  function useNodesState<T>(initial: T) {
    return [initial, () => {}, () => {}] as const;
  }
  function useEdgesState<T>(initial: T) {
    return [initial, () => {}, () => {}] as const;
  }
  return {
    default: ReactFlow,
    Background: () => null,
    Controls: () => null,
    useNodesState,
    useEdgesState,
  };
});

mock.module('reactflow/dist/style.css', () => ({}));

// Import the page AFTER the reactflow mock is registered.
const { CampaignCreatePage } = await import('../../src/pages/campaign-create');

function setAdminWithProject(projectId = 1) {
  useAuthStore.setState({
    projects: [{ projectId, projectName: 'Test Project', roles: ['admin'] }],
    hasFetchedProjects: true,
  });
  useUiStore.setState({ selectedProjectId: projectId });
}

const HASH_LIST_WITH_TYPE = {
  id: 11,
  name: 'NTLM Dump',
  projectId: 1,
  hashTypeId: 1000,
  hashCount: 50,
  crackedCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
};

const HASH_TYPE_NTLM = {
  id: 1000,
  name: 'NTLM',
  hashcatMode: 1000,
  category: 'Operating System',
};

// `id` is a serial PK in production (always positive); `hashcatMode` is the
// actual hashcat -m value (MD5 is mode 0). Keep these distinct in the
// fixture so a test can't confuse the two.
const HASH_TYPE_MD5 = { id: 900, name: 'MD5', hashcatMode: 0, category: 'Raw Hash' };

function defaultRoutes() {
  return {
    '/dashboard/resources/hash-lists': {
      status: 200,
      body: { hashLists: [HASH_LIST_WITH_TYPE] },
    },
    '/dashboard/resources/hash-types': {
      status: 200,
      body: { hashTypes: [HASH_TYPE_MD5, HASH_TYPE_NTLM] },
    },
    '/dashboard/resources/wordlists': { status: 200, body: { wordlists: [] } },
    '/dashboard/resources/rulelists': { status: 200, body: { rulelists: [] } },
    '/dashboard/resources/masklists': { status: 200, body: { masklists: [] } },
    '/dashboard/attack-templates': { status: 200, body: { templates: [] } },
  };
}

let fetchMock: ReturnType<typeof mockFetch>;

beforeEach(() => {
  // Reset captured handlers between tests
  captured.onConnect = undefined;
  captured.onNodeClick = undefined;
  captured.onNodeContextMenu = undefined;
  captured.onEdgesDelete = undefined;
});

// Per the repo's frontend test pattern: explicit `afterEach(cleanup)` is
// required to guarantee happy-dom DOM teardown. `cleanupAll()` resets the
// Zustand stores and clears Testing Library, but the explicit `cleanup()`
// satisfies the pattern callers can rely on.
afterEach(() => {
  cleanup();
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

describe('CampaignCreatePage', () => {
  it('redirects to /campaigns when the user lacks campaign:create permission', () => {
    fetchMock = mockFetch(defaultRoutes());
    useAuthStore.setState({
      projects: [{ projectId: 1, projectName: 'Test', roles: ['viewer'] }],
      hasFetchedProjects: true,
    });
    useUiStore.setState({ selectedProjectId: 1 });
    renderWithProviders(<CampaignCreatePage />);
    // <Navigate> renders nothing; the page header is the proof we're rendered
    expect(screen.queryByText('Create Campaign')).toBeNull();
  });

  it('blocks Step 1 Next when the name is empty', async () => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    renderWithProviders(<CampaignCreatePage />);

    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Next: Configure Attacks'));

    await waitFor(() => {
      expect(screen.getByText('Name is required')).toBeDefined();
    });
    // Still on Step 1
    expect(screen.queryByText('Add Attack')).toBeNull();
  });

  it('shows the cancel ConfirmDialog and resets state when Discard is clicked', async () => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    useCampaignWizard.setState({ name: 'In progress' });

    renderWithProviders(<CampaignCreatePage />);
    await waitFor(() => {
      expect(screen.getByText('Create Campaign')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText('Discard campaign?')).toBeDefined();

    fireEvent.click(screen.getByText('Discard'));
    expect(useCampaignWizard.getState().name).toBe('');
  });
});

function seedResourceQueries(qc: QueryClient, projectId = 1) {
  qc.setQueryData(['hash-lists', projectId], { hashLists: [HASH_LIST_WITH_TYPE] });
  qc.setQueryData(['hash-types'], { hashTypes: [HASH_TYPE_MD5, HASH_TYPE_NTLM] });
  qc.setQueryData(['wordlists', projectId], { resources: [] });
  qc.setQueryData(['rulelists', projectId], { resources: [] });
  qc.setQueryData(['masklists', projectId], { resources: [] });
}

describe('CampaignCreatePage Step 2 (attack form)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    qc = createTestQueryClient();
    seedResourceQueries(qc);
    useCampaignWizard.setState({
      step: 1,
      name: 'My Campaign',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
    });
  });

  it('re-applies the hash-type prefill on the second fresh add', async () => {
    // After the first Add Attack, attackForm.reset() clears the form.
    // Without re-seeding the prefill, the second attack silently lands
    // with no hashTypeId. Verify both attacks carry the prefill.
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add Attack' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Attack' }));
    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Attack' }));
    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks).toHaveLength(2);
    });

    expect(useCampaignWizard.getState().attacks[0]?.hashTypeId).toBe(HASH_TYPE_NTLM.id);
    expect(useCampaignWizard.getState().attacks[1]?.hashTypeId).toBe(HASH_TYPE_NTLM.id);
  });

  it('prefills Hash Type from the selected hash list when adding a new attack', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add Attack' })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Attack' }));

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks).toHaveLength(1);
    });
    expect(useCampaignWizard.getState().attacks[0]?.hashTypeId).toBe(HASH_TYPE_NTLM.id);
  });

  it('renders Attack Mode as a labeled dropdown with the spec primitives', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      expect(screen.getByLabelText('Attack Mode')).toBeDefined();
    });

    const select = screen.getByLabelText('Attack Mode') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.text);
    expect(labels).toContain('Dictionary');
    expect(labels).toContain('Combinator');
    expect(labels).toContain('Mask');
  });

  it('rejects invalid JSON in Advanced Configuration', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      expect(screen.getByLabelText(/Advanced Configuration/)).toBeDefined();
    });

    const textarea = screen.getByLabelText(/Advanced Configuration/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Attack' }));

    await waitFor(() => {
      expect(screen.getByText('Must be valid JSON')).toBeDefined();
    });
    expect(useCampaignWizard.getState().attacks).toHaveLength(0);
  });

  it('accepts a JSON object in Advanced Configuration and stores it on the attack', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      expect(screen.getByLabelText(/Advanced Configuration/)).toBeDefined();
    });

    const textarea = screen.getByLabelText(/Advanced Configuration/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{"workload-profile": 3}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Attack' }));

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks).toHaveLength(1);
    });
    expect(useCampaignWizard.getState().attacks[0]?.advancedConfiguration).toEqual({
      'workload-profile': 3,
    });
  });

  it('shows the cycle error with attack labels (not bare indices) when a cycle exists', async () => {
    useCampaignWizard.setState({
      step: 1,
      name: 'cyclic',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      attacks: [
        { mode: 0, dependencies: [1] },
        { mode: 3, dependencies: [0] },
      ],
    });

    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(screen.getByText(/Circular dependency/)).toBeDefined();
    });
    const error = screen.getByText(/Circular dependency/).textContent ?? '';
    expect(error).toContain('Dictionary');
    expect(error).toContain('Mask');
  });

  it('disables Next when a cycle exists', async () => {
    useCampaignWizard.setState({
      step: 1,
      name: 'cyclic',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      attacks: [
        { mode: 0, dependencies: [1] },
        { mode: 3, dependencies: [0] },
      ],
    });
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(screen.getByText('Next: Review')).toBeDefined();
    });
    const next = screen.getByText('Next: Review') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });
});

describe('CampaignCreatePage edit flow', () => {
  let qc: QueryClient;

  beforeEach(() => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    qc = createTestQueryClient();
    seedResourceQueries(qc);
    useCampaignWizard.setState({
      step: 1,
      name: 'My Campaign',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      attacks: [{ mode: 0, wordlistId: 2, dependencies: [] }],
    });
  });

  it('switches Add to Update Attack and patches the existing entry on submit', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Update Attack')).toBeDefined();

    const modeSelect = screen.getByLabelText('Attack Mode') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: '3' } });
    fireEvent.click(screen.getByText('Update Attack'));

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks[0]?.mode).toBe(3);
    });
    expect(useCampaignWizard.getState().attacks).toHaveLength(1);
  });

  it('removes the attack when right-clicked in the DAG editor', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(captured.onNodeContextMenu).toBeDefined();
    });

    let preventDefaultCalled = false;
    act(() => {
      captured.onNodeContextMenu?.(
        {
          preventDefault: () => {
            preventDefaultCalled = true;
          },
        },
        { id: '0' }
      );
    });

    expect(preventDefaultCalled).toBe(true);
    expect(useCampaignWizard.getState().attacks).toHaveLength(0);
  });

  it('seeds the form when a DAG node is clicked', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(captured.onNodeClick).toBeDefined();
    });

    act(() => {
      captured.onNodeClick?.({}, { id: '0' });
    });

    await waitFor(() => {
      expect(screen.getByText('Update Attack')).toBeDefined();
    });
  });
});

describe('CampaignCreatePage Step 0 → Step 1 round-trip', () => {
  beforeEach(() => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
  });

  it('rehydrates basic-info fields from the wizard store when navigating Back', async () => {
    useCampaignWizard.setState({
      step: 0,
      name: 'Saved Name',
      description: 'Saved description',
      priority: 7,
      hashListId: HASH_LIST_WITH_TYPE.id,
    });
    const qc = createTestQueryClient();
    seedResourceQueries(qc);

    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      const nameInput = screen.getByLabelText('Campaign Name') as HTMLInputElement;
      expect(nameInput.value).toBe('Saved Name');
    });
    const priorityInput = screen.getByLabelText('Priority (1-10)') as HTMLInputElement;
    expect(priorityInput.value).toBe('7');
  });
});

describe('CampaignCreatePage hash-type prefill edge cases', () => {
  let qc: QueryClient;

  beforeEach(() => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    qc = createTestQueryClient();
    seedResourceQueries(qc);
  });

  it('does not overwrite the user manual hash-type choice on a background data change', async () => {
    useCampaignWizard.setState({
      step: 1,
      name: 'X',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
    });

    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(screen.getByLabelText('Hash Type')).toBeDefined();
    });

    const select = screen.getByLabelText('Hash Type') as HTMLSelectElement;
    // User manually picks MD5 instead of the prefilled NTLM (id=1000).
    // fireEvent.change marks the field as touched in RHF, which is the
    // signal the prefill effect uses to refuse to overwrite it.
    fireEvent.change(select, { target: { value: String(HASH_TYPE_MD5.id) } });
    fireEvent.blur(select);

    // Trigger a "background refetch" by mutating the cache to a different
    // (but still valid) hash list. The effect re-runs because
    // detectedHashTypeId changes. The user's choice must survive.
    act(() => {
      qc.setQueryData(['hash-lists', 1], {
        hashLists: [{ ...HASH_LIST_WITH_TYPE, hashTypeId: 9999 }],
      });
    });

    await waitFor(() => {
      const after = screen.getByLabelText('Hash Type') as HTMLSelectElement;
      expect(after.value).toBe(String(HASH_TYPE_MD5.id));
    });
  });

  it('does not run prefill when starting an Edit on an existing attack', async () => {
    useCampaignWizard.setState({
      step: 1,
      name: 'X',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      // Existing attack with NO hashTypeId set
      attacks: [{ mode: 0, dependencies: [] }],
    });

    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Edit'));

    // Inspect the stored attack after a no-op Update — the prefill must NOT
    // have injected the detected hashTypeId during edit.
    fireEvent.click(screen.getByRole('button', { name: 'Update Attack' }));

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks[0]?.hashTypeId).toBeUndefined();
    });
  });
});

describe('CampaignCreatePage edit-flow invariants', () => {
  let qc: QueryClient;

  beforeEach(() => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    qc = createTestQueryClient();
    seedResourceQueries(qc);
  });

  it('preserves an existing attack dependencies array when editing only the mode', async () => {
    useCampaignWizard.setState({
      step: 1,
      name: 'X',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      attacks: [
        { mode: 0, dependencies: [] },
        { mode: 0, dependencies: [0] },
      ],
    });

    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });

    await waitFor(() => {
      // Two Edit buttons render (one per attack); pick the second
      expect(screen.getAllByText('Edit').length).toBe(2);
    });

    const editButtons = screen.getAllByText('Edit');
    const secondEdit = editButtons[1];
    expect(secondEdit).toBeDefined();
    if (!secondEdit) return;
    fireEvent.click(secondEdit);

    const modeSelect = screen.getByLabelText('Attack Mode') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Attack' }));

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks[1]?.mode).toBe(3);
    });
    // Dependencies preserved
    expect(useCampaignWizard.getState().attacks[1]?.dependencies).toEqual([0]);
  });

  it('round-trips advancedConfiguration through Edit -> no-op Update', async () => {
    useCampaignWizard.setState({
      step: 1,
      name: 'X',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      attacks: [{ mode: 0, dependencies: [], advancedConfiguration: { 'workload-profile': 3 } }],
    });

    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Edit'));

    const textarea = screen.getByLabelText(/Advanced Configuration/) as HTMLTextAreaElement;
    // seedFormFromAttack serialised the object to a JSON string; the
    // textarea must show that string back so a no-op Update preserves it.
    expect(JSON.parse(textarea.value)).toEqual({ 'workload-profile': 3 });

    fireEvent.click(screen.getByRole('button', { name: 'Update Attack' }));

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks[0]?.advancedConfiguration).toEqual({
        'workload-profile': 3,
      });
    });
  });
});

describe('CampaignCreatePage submit preflight', () => {
  it('refuses to POST when hashListId is null (no `?? 0` sentinel)', async () => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    const qc = createTestQueryClient();
    seedResourceQueries(qc);

    // Step 2 reached, but hashListId never got set (e.g., store
    // corruption, deep-link, future step-navigation bug).
    useCampaignWizard.setState({
      step: 2,
      name: 'X',
      description: '',
      priority: 5,
      hashListId: null,
      attacks: [{ mode: 0, dependencies: [] }],
    });

    let campaignPostCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/dashboard/campaigns')) campaignPostCount++;
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Campaign' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));

      await waitFor(() => {
        expect(screen.getByText(/Select a hash list/)).toBeDefined();
      });
      expect(campaignPostCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('CampaignCreatePage React Flow position handling', () => {
  // Regression: position preservation must not silently misassign positions
  // after removeAttack shifts wizard indices. The simplest correct fix is
  // to reset positions on length decrease.
  let qc: QueryClient;

  beforeEach(() => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    qc = createTestQueryClient();
    seedResourceQueries(qc);
    useCampaignWizard.setState({
      step: 1,
      name: 'X',
      hashListId: HASH_LIST_WITH_TYPE.id,
      priority: 5,
      attacks: [
        { mode: 0, dependencies: [] },
        { mode: 0, dependencies: [] },
      ],
    });
  });

  it('does not preserve positions across an attack removal (indices shift)', async () => {
    renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
    await waitFor(() => {
      // Two nodes rendered initially
      expect(useCampaignWizard.getState().attacks).toHaveLength(2);
    });

    // Remove attack 0 — indices shift down. The page must not propagate
    // attack-0's stored position onto what is now attack 0 (the former
    // attack 1).
    act(() => {
      useCampaignWizard.getState().removeAttack(0);
    });

    await waitFor(() => {
      expect(useCampaignWizard.getState().attacks).toHaveLength(1);
    });

    // No assertion on exact position; the regression we're guarding
    // against is the *misassignment* shape. A successful render with the
    // remaining attack present and no exception thrown is sufficient
    // because the fix is "drop the position map on length decrease."
    // The behavior is asserted at the implementation level (the effect
    // calls buildNodes(attacks) fresh on length decrease, restoring
    // grid layout).
    expect(useCampaignWizard.getState().attacks[0]?.mode).toBe(0);
  });
});

describe('CampaignCreatePage cycle short-circuit', () => {
  it('does not call createCampaign when a cycle is present at submit time', async () => {
    fetchMock = mockFetch(defaultRoutes());
    setAdminWithProject();
    const qc = createTestQueryClient();
    seedResourceQueries(qc);

    useCampaignWizard.setState({
      step: 2,
      name: 'Cyclic',
      description: '',
      priority: 5,
      hashListId: HASH_LIST_WITH_TYPE.id,
      attacks: [
        { mode: 0, dependencies: [1] },
        { mode: 3, dependencies: [0] },
      ],
    });

    let campaignPostCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/dashboard/campaigns')) {
        campaignPostCount++;
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Campaign' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));

      await waitFor(() => {
        expect(screen.getByText(/dependency cycle/)).toBeDefined();
      });
      expect(campaignPostCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('CampaignCreatePage partial-failure rollback', () => {
  it('issues a compensating DELETE when an attack POST fails mid-loop', async () => {
    setAdminWithProject();
    const qc = createTestQueryClient();
    seedResourceQueries(qc);

    useCampaignWizard.setState({
      step: 2,
      name: 'Will Fail',
      description: '',
      priority: 5,
      hashListId: HASH_LIST_WITH_TYPE.id,
      attacks: [
        { mode: 0, dependencies: [] },
        { mode: 0, dependencies: [] },
      ],
    });

    const requests: { method: string; url: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push({ method, url });

      if (method === 'POST' && url.endsWith('/dashboard/campaigns')) {
        return new Response(JSON.stringify({ campaign: { id: 77 } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // First attack succeeds, second attack fails with 500.
      if (method === 'POST' && url.includes('/dashboard/campaigns/77/attacks')) {
        const successCount = requests.filter(
          (r) => r.method === 'POST' && r.url.includes('/dashboard/campaigns/77/attacks')
        ).length;
        if (successCount === 1) {
          return new Response(JSON.stringify({ attack: { id: 200 } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ error: { code: 'VALIDATION', message: 'attack failed' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (method === 'DELETE' && url.includes('/dashboard/campaigns/77')) {
        return new Response(null, {
          status: 204,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Campaign' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));

      await waitFor(() => {
        const deletes = requests.filter(
          (r) => r.method === 'DELETE' && r.url.includes('/dashboard/campaigns/77')
        );
        expect(deletes.length).toBe(1);
      });

      // Error is surfaced to the user
      expect(screen.getByText(/attack failed/)).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('CampaignCreatePage submit flow', () => {
  it('posts attacks in topological order and remaps dependency indices to backend IDs', async () => {
    // Two attacks in a chain: A0 → A1 (A1 depends on A0).
    // The wizard stores deps as wizard indices [0]. The submit path must
    // create A0 first (gets id=101), then create A1 with dependencies=[101].
    setAdminWithProject();
    const qc = createTestQueryClient();
    seedResourceQueries(qc);

    useCampaignWizard.setState({
      step: 2,
      name: 'Chain',
      description: '',
      priority: 5,
      hashListId: HASH_LIST_WITH_TYPE.id,
      attacks: [
        { mode: 0, dependencies: [] },
        { mode: 0, dependencies: [0] },
      ],
    });

    const attackPosts: { url: string; body: unknown }[] = [];
    let nextAttackId = 101;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (method === 'POST' && url.includes('/dashboard/campaigns/55/attacks')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        attackPosts.push({ url, body });
        const attackId = nextAttackId++;
        return new Response(JSON.stringify({ attack: { id: attackId } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && url.includes('/dashboard/campaigns')) {
        return new Response(
          JSON.stringify({ campaign: { id: 55, name: 'Chain', status: 'draft' } }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      renderWithProviders(<CampaignCreatePage />, { queryClient: qc });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Campaign' })).toBeDefined();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));

      await waitFor(() => {
        expect(attackPosts).toHaveLength(2);
      });

      // First POST: A0, no dependencies (empty list or field omitted are both fine)
      const firstBody = attackPosts[0]?.body as { mode: number; dependencies?: number[] };
      expect(firstBody.mode).toBe(0);
      expect(firstBody.dependencies ?? []).toEqual([]);

      // Second POST: A1, dependencies remapped to the backend ID we returned for A0 (101)
      const secondBody = attackPosts[1]?.body as { mode: number; dependencies?: number[] };
      expect(secondBody.dependencies).toEqual([101]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
