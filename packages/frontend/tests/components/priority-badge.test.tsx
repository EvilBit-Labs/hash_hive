import { afterEach, describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { PriorityBadge, priorityBucket } from '../../src/components/features/priority-badge';
import { cleanupAll, renderWithProviders } from '../test-utils';

afterEach(cleanupAll);

describe('PriorityBadge', () => {
  it('renders "high" for priority=1 with destructive styling', () => {
    const { container } = renderWithProviders(<PriorityBadge priority={1} />);
    expect(screen.getByText('high')).toBeDefined();
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-destructive');
  });

  it('renders "normal" for priority=5 with info styling', () => {
    const { container } = renderWithProviders(<PriorityBadge priority={5} />);
    expect(screen.getByText('normal')).toBeDefined();
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-info');
  });

  it('renders "low" for priority=10 with muted styling', () => {
    const { container } = renderWithProviders(<PriorityBadge priority={10} />);
    expect(screen.getByText('low')).toBeDefined();
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-muted-foreground');
  });

  it('falls back to normal styling for unknown priorities', () => {
    const { container } = renderWithProviders(<PriorityBadge priority={3} />);
    expect(screen.getByText('normal')).toBeDefined();
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-info');
  });
});

describe('priorityBucket', () => {
  it('maps the three canonical priorities', () => {
    expect(priorityBucket(1)).toBe('high');
    expect(priorityBucket(5)).toBe('normal');
    expect(priorityBucket(10)).toBe('low');
  });

  it('falls back to normal for any other integer', () => {
    expect(priorityBucket(0)).toBe('normal');
    expect(priorityBucket(2)).toBe('normal');
    expect(priorityBucket(7)).toBe('normal');
    expect(priorityBucket(100)).toBe('normal');
  });
});
