import { afterEach, describe, expect, it } from 'bun:test';
import { ProgressBar } from '../../src/components/ui/progress-bar';
import { cleanupAll, renderWithProviders } from '../test-utils';

afterEach(cleanupAll);

describe('ProgressBar', () => {
  it('renders aria-valuenow rounded from a 0-1 fractional input', () => {
    const { container } = renderWithProviders(<ProgressBar value={0.756} ariaLabel="Progress" />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('76');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
  });

  it('accepts the 0-100 percentage scale without doubling it', () => {
    const { container } = renderWithProviders(<ProgressBar value={42} ariaLabel="Progress" />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
  });

  it('clamps values above 100 to 100', () => {
    const { container } = renderWithProviders(<ProgressBar value={150} ariaLabel="Progress" />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('clamps negative values to 0', () => {
    const { container } = renderWithProviders(<ProgressBar value={-5} ariaLabel="Progress" />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('coerces non-finite inputs (NaN, Infinity) to 0', () => {
    const { container } = renderWithProviders(<ProgressBar value={Number.NaN} ariaLabel="X" />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('renders the visible label below the bar when provided', () => {
    const { getByText } = renderWithProviders(<ProgressBar value={0.5} label="50% complete" />);
    expect(getByText('50% complete')).toBeDefined();
  });

  it('applies thin sizing class when size="thin"', () => {
    const { container } = renderWithProviders(
      <ProgressBar value={0.5} size="thin" ariaLabel="Progress" />
    );
    const track = container.querySelector('[role="progressbar"]');
    expect(track?.className).toContain('h-1.5');
  });

  it('applies destructive tone class when tone="destructive"', () => {
    const { container } = renderWithProviders(
      <ProgressBar value={0.5} tone="destructive" ariaLabel="Progress" />
    );
    const fill = container.querySelector('[role="progressbar"] > div');
    expect(fill?.className).toContain('bg-destructive');
  });
});
