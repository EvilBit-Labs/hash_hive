import { afterEach, describe, expect, it } from 'bun:test';
import { ConnectionIndicator } from '../../src/components/features/connection-indicator';
import { cleanupAll, renderWithProviders, screen } from '../test-utils';

afterEach(cleanupAll);

describe('ConnectionIndicator', () => {
  it('shows "Live" when connected', () => {
    renderWithProviders(<ConnectionIndicator connected={true} />);

    expect(screen.getByText('Live')).toBeDefined();
    // Check for green dot
    const dot = document.querySelector('.bg-success');
    expect(dot).not.toBeNull();
  });

  it('shows "Reconnecting..." when disconnected', () => {
    renderWithProviders(<ConnectionIndicator connected={false} />);

    expect(screen.getByText('Reconnecting...')).toBeDefined();
    // Check for red dot
    const dot = document.querySelector('.bg-destructive');
    expect(dot).not.toBeNull();
  });
});
