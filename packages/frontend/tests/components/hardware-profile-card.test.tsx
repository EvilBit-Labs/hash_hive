import { afterEach, describe, expect, it } from 'bun:test';
import { screen } from '@testing-library/react';
import { HardwareProfileCard } from '../../src/components/features/hardware-profile-card';
import { cleanupAll, renderWithProviders } from '../test-utils';

// cleanupAll() also resets Zustand stores, which is the project-wide
// convention; bare `cleanup` only touches the DOM.
afterEach(cleanupAll);

describe('HardwareProfileCard', () => {
  it('renders empty state when profile is null', () => {
    renderWithProviders(<HardwareProfileCard profile={null} />);
    expect(screen.getByText('No hardware profile reported yet.')).toBeDefined();
  });

  it('renders known shape with OS, CPU, RAM, GPU sections', () => {
    renderWithProviders(
      <HardwareProfileCard
        profile={{
          os: { name: 'Linux', version: '6.10', platform: 'x86_64' },
          cpu: { model: 'AMD Ryzen 9 7950X', cores: 32 },
          ram: { totalMb: 65536, availableMb: 32768 },
          gpus: [{ model: 'RTX 4090', memoryMb: 24576, driver: '550.120' }],
          hashcatVersion: '6.2.6',
        }}
      />
    );

    expect(screen.getByText('OS')).toBeDefined();
    expect(screen.getByText('Linux')).toBeDefined();
    expect(screen.getByText('CPU')).toBeDefined();
    expect(screen.getByText('AMD Ryzen 9 7950X')).toBeDefined();
    expect(screen.getByText('RAM')).toBeDefined();
    expect(screen.getByText('GPUs (1)')).toBeDefined();
    expect(screen.getByText('RTX 4090')).toBeDefined();
    expect(screen.getByText('6.2.6')).toBeDefined();
  });

  it('renders raw profile disclosure for unknown shapes', () => {
    renderWithProviders(<HardwareProfileCard profile={{ legacyKey: 'someValue' }} />);
    expect(screen.getByText('Raw profile (unknown shape)')).toBeDefined();
  });

  it('renders GPU empty message when gpus is an empty array', () => {
    renderWithProviders(<HardwareProfileCard profile={{ gpus: [] }} />);
    expect(screen.getByText('GPUs (0)')).toBeDefined();
    expect(screen.getByText('No GPUs reported.')).toBeDefined();
  });
});
