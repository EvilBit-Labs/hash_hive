import { afterEach, describe, expect, it } from 'bun:test';
import { CampaignTaskStats } from '../../src/components/features/campaign-task-stats';
import { cleanupAll, renderWithProviders, screen } from '../test-utils';

afterEach(cleanupAll);

describe('CampaignTaskStats', () => {
  it('renders all five tiles with the supplied counts', () => {
    renderWithProviders(
      <CampaignTaskStats stats={{ total: 42, pending: 5, running: 10, completed: 25, failed: 2 }} />
    );

    expect(screen.getByTestId('task-stat-total').textContent).toContain('42');
    expect(screen.getByTestId('task-stat-pending').textContent).toContain('5');
    expect(screen.getByTestId('task-stat-running').textContent).toContain('10');
    expect(screen.getByTestId('task-stat-completed').textContent).toContain('25');
    expect(screen.getByTestId('task-stat-failed').textContent).toContain('2');
  });

  it('falls back to zeros when stats is null', () => {
    renderWithProviders(<CampaignTaskStats stats={null} />);

    expect(screen.getByTestId('task-stat-total').textContent).toContain('0');
    expect(screen.getByTestId('task-stat-failed').textContent).toContain('0');
  });

  it('formats large counts with thousands separators', () => {
    renderWithProviders(
      <CampaignTaskStats
        stats={{ total: 12345, pending: 0, running: 0, completed: 12345, failed: 0 }}
      />
    );

    expect(screen.getByTestId('task-stat-total').textContent).toContain('12,345');
  });
});
