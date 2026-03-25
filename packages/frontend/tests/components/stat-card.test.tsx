import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, screen, fireEvent } from '@testing-library/react';
import { StatCard } from '../../src/components/features/stat-card';
import { renderWithProviders, renderWithRouter } from '../test-utils';

afterEach(cleanup);

describe('StatCard', () => {
  it('should render title, value, and subtitle', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />);
    expect(screen.getByText('Agents')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
    expect(screen.getByText('3 online')).toBeDefined();
  });

  it('should show placeholder when loading', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" loading />);
    expect(screen.getByText('--')).toBeDefined();
    expect(screen.queryByText('7')).toBeNull();
  });

  it('should render string values', () => {
    renderWithProviders(<StatCard title="Status" value="Active" subtitle="All systems go" />);
    expect(screen.getByText('Active')).toBeDefined();
  });

  it('should render as a div when no "to" prop is provided', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('should render as a button when "to" prop is provided', () => {
    renderWithProviders(<StatCard title="Agents" value={7} subtitle="3 online" to="/agents" />);
    const button = screen.getByRole('button');
    expect(button).toBeDefined();
    expect(button.tagName).toBe('BUTTON');
  });

  it('should navigate to the target route when clicked', () => {
    renderWithRouter(
      [
        {
          path: '/',
          element: <StatCard title="Agents" value={7} subtitle="3 online" to="/agents" />,
        },
        { path: '/agents', element: <div>Agents Page</div> },
      ],
      { initialRoute: '/' }
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Agents Page')).toBeDefined();
  });
});
