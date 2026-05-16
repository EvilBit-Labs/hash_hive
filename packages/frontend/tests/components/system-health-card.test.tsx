/**
 * Tests for SystemHealthCard (issue #109).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SystemHealthCard } from '../../src/components/features/system-health-card';
import type { SystemHealth } from '../../src/hooks/use-system-health';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch> | undefined;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

beforeEach(() => {
  fetchMock = undefined;
});

function buildHealth(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    status: 'healthy',
    timestamp: '2026-05-06T12:00:00.000Z',
    version: '1.1.0',
    components: {
      database: { status: 'healthy', durationMs: 4 },
      redis: { status: 'healthy', durationMs: 2 },
      minio: { status: 'healthy', durationMs: 8, detail: { bucket: 'hashhive' } },
      queues: {
        status: 'healthy',
        durationMs: 12,
        detail: { queues: { 'tasks-normal': { waiting: 1, active: 0, failed: 0 } } },
      },
    },
    ...overrides,
  };
}

describe('SystemHealthCard', () => {
  it('renders skeleton rows while the query is loading', () => {
    fetchMock = mockFetch({
      '/dashboard/health': { status: 200, body: buildHealth() },
    });
    renderWithProviders(<SystemHealthCard />);

    // Before fetch resolves: skeleton rows are visible with -- placeholder
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  it('renders aggregate "All systems healthy" when all components are healthy', async () => {
    fetchMock = mockFetch({
      '/dashboard/health': { status: 200, body: buildHealth() },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByText('All systems healthy')).toBeDefined();
    });
    // All four component labels rendered
    expect(screen.getByText('Database')).toBeDefined();
    expect(screen.getByText('Redis')).toBeDefined();
    expect(screen.getByText('Object Storage')).toBeDefined();
    expect(screen.getByText('Job Queues')).toBeDefined();
  });

  it('renders aggregate "Degraded" with the per-component message visible', async () => {
    fetchMock = mockFetch({
      '/dashboard/health': {
        status: 200,
        body: buildHealth({
          status: 'degraded',
          components: {
            database: {
              status: 'degraded',
              message: 'pool 90% full',
              durationMs: 4,
            },
            redis: { status: 'healthy', durationMs: 2 },
            minio: { status: 'healthy', durationMs: 8, detail: { bucket: 'hashhive' } },
            queues: { status: 'healthy', durationMs: 12 },
          },
        }),
      },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByText('Degraded')).toBeDefined();
    });
    expect(screen.getByText('pool 90% full')).toBeDefined();
  });

  it('renders aggregate "Unhealthy" when a component is unhealthy', async () => {
    fetchMock = mockFetch({
      '/dashboard/health': {
        status: 200,
        body: buildHealth({
          status: 'unhealthy',
          components: {
            database: { status: 'healthy', durationMs: 4 },
            redis: { status: 'unhealthy', message: 'connection refused', durationMs: 2 },
            minio: { status: 'healthy', durationMs: 8, detail: { bucket: 'hashhive' } },
            queues: { status: 'healthy', durationMs: 12 },
          },
        }),
      },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByText('Unhealthy')).toBeDefined();
    });
    expect(screen.getByText('connection refused')).toBeDefined();
    // Aggregate uses role="status" so SR readers announce the change
    const statusEl = screen.getByRole('status');
    expect(statusEl.getAttribute('aria-live')).toBe('polite');
  });

  it('per-component status text reflects the component status (not just aggregate)', async () => {
    // Issue #109 (PR review C-2): a regression that mapped every dot to
    // bg-success would pass an aggregate-label-only test. Pin the
    // per-row status text via the existing aria-label (`<COMPONENT>
    // status: <status>...`) so a row-shuffle regression that put the
    // wrong status next to the wrong row also fails. All four fixture
    // components include a `detail` payload so each row renders as a
    // button (the row scoping needs the aria-label, which only the
    // expandable button form provides).
    fetchMock = mockFetch({
      '/dashboard/health': {
        status: 200,
        body: buildHealth({
          status: 'unhealthy',
          components: {
            database: {
              status: 'unhealthy',
              message: 'pool exhausted',
              durationMs: 4,
              detail: { connectionsUsed: 100, connectionsMax: 100 },
            },
            redis: {
              status: 'degraded',
              message: 'high latency',
              durationMs: 2,
              detail: { latencyMs: 800 },
            },
            minio: { status: 'healthy', durationMs: 8, detail: { bucket: 'hashhive' } },
            queues: {
              status: 'healthy',
              durationMs: 12,
              detail: { queues: { 'tasks-normal': { waiting: 1, active: 0, failed: 0 } } },
            },
          },
        }),
      },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByText('Unhealthy')).toBeDefined();
    });

    // Per-row scoping: each row's status is wired into its aria-label
    // (e.g. "Database status: unhealthy. Click to show details.").
    // A row-shuffle regression would map the wrong status to the wrong
    // row's label and fail these assertions — unlike a global
    // `getAllByText('healthy').length >= 1` which can't catch shuffles.
    const dbRow = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('Database status:'));
    expect(dbRow?.getAttribute('aria-label')).toContain('unhealthy');

    const redisRow = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('Redis status:'));
    expect(redisRow?.getAttribute('aria-label')).toContain('degraded');

    const minioRow = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('Object Storage status:'));
    expect(minioRow?.getAttribute('aria-label')).toContain('healthy');

    // Per-component messages render adjacent to their row.
    expect(screen.getByText('pool exhausted')).toBeDefined();
    expect(screen.getByText('high latency')).toBeDefined();
  });

  it('expands per-component detail on click when detail is present', async () => {
    fetchMock = mockFetch({
      '/dashboard/health': {
        status: 200,
        body: buildHealth({
          components: {
            database: { status: 'healthy', durationMs: 4 },
            redis: { status: 'healthy', durationMs: 2 },
            minio: { status: 'healthy', durationMs: 8, detail: { bucket: 'hashhive' } },
            queues: {
              status: 'healthy',
              durationMs: 12,
              detail: {
                queues: { 'tasks-high': { waiting: 5, active: 1, failed: 0 } },
              },
            },
          },
        }),
      },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByText('Job Queues')).toBeDefined();
    });

    const queuesButton = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('Job Queues'));
    expect(queuesButton).toBeDefined();
    expect(queuesButton!.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(queuesButton!);
    expect(queuesButton!.getAttribute('aria-expanded')).toBe('true');

    // Detail JSON now visible
    expect(screen.getByText(/tasks-high/)).toBeDefined();
  });

  it('renders an inline error banner when the query fails', async () => {
    fetchMock = mockFetch({
      '/dashboard/health': { status: 500, body: { error: { code: 'X', message: 'boom' } } },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeDefined();
      },
      { timeout: 2000 }
    );
    expect(screen.getByRole('alert').textContent).toMatch(/Failed to load system health/);
  });

  // Issue #109 testing review T-007. The keyboard-operability claim
  // ("Enter/Space activate the row") rests on the row being a native
  // `<button>` — browsers translate Enter/Space presses into click on
  // native buttons, but not on `<div role="button">` without an
  // explicit onKeyDown. We pin the native-button tag here and exercise
  // the click handler that Enter would produce; happy-dom doesn't
  // synthesize the Enter→click translation, so a real keyDown event
  // would be testing happy-dom rather than our component.
  it('component row is a native <button> tag (gives Enter/Space activation for free)', async () => {
    fetchMock = mockFetch({
      '/dashboard/health': {
        status: 200,
        body: buildHealth({
          components: {
            database: { status: 'healthy', durationMs: 4 },
            redis: { status: 'healthy', durationMs: 2 },
            minio: { status: 'healthy', durationMs: 8, detail: { bucket: 'hashhive' } },
            queues: {
              status: 'healthy',
              durationMs: 12,
              detail: { queues: { 'tasks-high': { waiting: 5, active: 1, failed: 0 } } },
            },
          },
        }),
      },
    });
    renderWithProviders(<SystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByText('Job Queues')).toBeDefined();
    });

    const queuesButton = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('Job Queues'));
    expect(queuesButton).toBeDefined();
    // Pin the keyboard contract: native <button> means Enter and Space
    // activate the element without any custom onKeyDown handler.
    expect(queuesButton!.tagName).toBe('BUTTON');
    queuesButton!.focus();
    expect(document.activeElement).toBe(queuesButton);
    // Dispatch the click that Enter/Space would produce on a native
    // button (happy-dom doesn't synthesize the Enter→click for us).
    fireEvent.click(queuesButton!);
    expect(queuesButton!.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders one skeleton row per component while loading', () => {
    fetchMock = mockFetch({
      '/dashboard/health': { status: 200, body: buildHealth() },
    });
    renderWithProviders(<SystemHealthCard />);

    // While the fetch is pending we should have exactly one row per
    // component. The four component labels render in both skeleton and
    // loaded states, so they're insufficient on their own to pin "we're
    // in the skeleton state". The skeleton-only signal is the `--`
    // status placeholder rendered by SkeletonRow — count those to
    // confirm the loading branch fired (one per component, possibly
    // plus one in the header).
    expect(screen.getByText('Database')).toBeDefined();
    expect(screen.getByText('Redis')).toBeDefined();
    expect(screen.getByText('Object Storage')).toBeDefined();
    expect(screen.getByText('Job Queues')).toBeDefined();
    // Skeleton-specific assertion: 4 rows × `--` placeholder, plus the
    // header `--` when no data is loaded yet (5 total, but allow >= 4
    // in case the header placeholder is suppressed).
    const placeholders = screen.getAllByText('--');
    expect(placeholders.length).toBeGreaterThanOrEqual(4);
  });
});
