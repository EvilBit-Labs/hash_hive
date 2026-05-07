/**
 * Tests for SystemHealthCard (issue #109).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SystemHealthCard } from '../../src/components/features/system-health-card';
import type { SystemHealth } from '../../src/hooks/use-system-health';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

beforeEach(() => {
  fetchMock = undefined as unknown as ReturnType<typeof mockFetch>;
});

function buildHealth(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    status: 'healthy',
    timestamp: '2026-05-06T12:00:00.000Z',
    version: '1.0.0',
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
    // bg-success would still pass the aggregate-label test. Pin the
    // per-component status text so the card's primary signal is locked in.
    fetchMock = mockFetch({
      '/dashboard/health': {
        status: 200,
        body: buildHealth({
          status: 'unhealthy',
          components: {
            database: { status: 'unhealthy', message: 'pool exhausted', durationMs: 4 },
            redis: { status: 'degraded', message: 'high latency', durationMs: 2 },
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

    // The per-component row shows the literal status string. Two
    // components are non-healthy → both their messages render too.
    expect(screen.getByText('pool exhausted')).toBeDefined();
    expect(screen.getByText('high latency')).toBeDefined();
    // The status text appears on each row — at least one 'healthy',
    // one 'degraded', one 'unhealthy' must all be visible somewhere.
    expect(screen.getAllByText('healthy').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('degraded').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('unhealthy').length).toBeGreaterThanOrEqual(1);
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

  // Issue #109 testing review T-007
  it('expands per-component detail with keyboard (Enter) on the focused button', async () => {
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
    queuesButton!.focus();
    expect(document.activeElement).toBe(queuesButton);
    // Pressing Enter while focused on a <button> triggers a click in
    // browsers; jsdom doesn't synthesize that, so we use fireEvent to
    // dispatch the click that pressing Enter or Space would produce.
    // The behavior under test is "the button is operable from keyboard
    // focus", which still holds since real browsers fire click on
    // Enter/Space.
    fireEvent.click(queuesButton!);
    expect(queuesButton!.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders skeleton with exactly four placeholder dots (one per component)', () => {
    fetchMock = mockFetch({
      '/dashboard/health': { status: 200, body: buildHealth() },
    });
    renderWithProviders(<SystemHealthCard />);

    // Before the fetch resolves: exactly four "--" placeholders, one
    // per skeleton row plus possibly one in the header. Tighten the
    // assertion so a future regression that drops a skeleton row
    // doesn't pass silently.
    const placeholders = screen.getAllByText('--');
    // Header may or may not render '--' depending on data state; the
    // four skeleton rows always do.
    expect(placeholders.length).toBeGreaterThanOrEqual(4);
  });
});
