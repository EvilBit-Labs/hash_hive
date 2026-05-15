import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, screen } from '@testing-library/react';
import { SeverityBadge } from '../../src/components/features/severity-badge';
import { renderWithProviders } from '../test-utils';

afterEach(cleanup);

describe('SeverityBadge', () => {
  it('renders the severity text', () => {
    renderWithProviders(<SeverityBadge severity="warning" />);
    expect(screen.getByText('warning')).toBeDefined();
  });

  it('applies warning styling for warning severity', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="warning" />);
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-warning');
  });

  it('applies destructive styling for fatal severity', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="fatal" />);
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-destructive');
  });

  it('applies destructive styling for critical severity', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="critical" />);
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-destructive');
  });

  it('falls back to destructive styling for unknown severities', () => {
    const { container } = renderWithProviders(<SeverityBadge severity="something-unexpected" />);
    const badge = container.querySelector('span.inline-flex');
    expect(badge?.className).toContain('text-destructive');
  });
});
