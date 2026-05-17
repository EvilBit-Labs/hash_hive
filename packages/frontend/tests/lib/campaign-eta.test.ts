import { describe, expect, it } from 'bun:test';
import { computeEta, formatDuration } from '../../src/lib/campaign-eta';
import type { CampaignActiveAgent, CampaignTaskStats } from '../../src/hooks/use-dashboard';

function makeAgent(speedHs: number | null): CampaignActiveAgent {
  return {
    agentId: 1,
    agentName: 'Rig',
    taskId: 1,
    attackId: 1,
    attackMode: 0,
    progress: null,
    speedHs,
  };
}

const ZERO_STATS: CampaignTaskStats = {
  total: 0,
  pending: 0,
  running: 0,
  completed: 0,
  failed: 0,
};

describe('computeEta', () => {
  it('returns "--" when stats are null', () => {
    expect(computeEta(null, [])).toBe('--');
  });

  it('returns "--" when no tasks exist', () => {
    expect(computeEta(ZERO_STATS, [makeAgent(1000)])).toBe('--');
  });

  it('returns "--" when all tasks are completed/failed', () => {
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 0,
      running: 0,
      completed: 8,
      failed: 2,
    };
    expect(computeEta(stats, [makeAgent(1000)])).toBe('--');
  });

  it('returns "--" when no agent reports a positive speed', () => {
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 5,
      running: 0,
      completed: 5,
      failed: 0,
    };
    expect(computeEta(stats, [makeAgent(null), makeAgent(0)])).toBe('--');
  });

  it('returns "--" when agents array is empty even with remaining work', () => {
    const stats: CampaignTaskStats = {
      total: 10,
      pending: 10,
      running: 0,
      completed: 0,
      failed: 0,
    };
    expect(computeEta(stats, [])).toBe('--');
  });

  it('returns a duration string when work and speed are non-trivial', () => {
    const stats: CampaignTaskStats = {
      total: 100,
      pending: 50,
      running: 50,
      completed: 0,
      failed: 0,
    };
    const result = computeEta(stats, [makeAgent(1000), makeAgent(2000)]);
    expect(result).not.toBe('--');
    expect(typeof result).toBe('string');
  });
});

describe('formatDuration', () => {
  it('returns "--" for non-finite values', () => {
    expect(formatDuration(Number.NaN)).toBe('--');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('--');
    expect(formatDuration(0)).toBe('--');
    expect(formatDuration(-5)).toBe('--');
  });

  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(12)).toBe('12s');
    expect(formatDuration(29)).toBe('29s');
  });

  it('formats sub-hour durations in minutes', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(300)).toBe('5m');
    expect(formatDuration(59 * 60)).toBe('59m');
  });

  it('formats multi-hour durations with hours + minutes', () => {
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe('2h 15m');
    expect(formatDuration(3600)).toBe('1h');
  });

  it('formats multi-day durations in days + hours', () => {
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2d 3h');
    expect(formatDuration(86400)).toBe('1d');
  });

  it('rounds the minute portion correctly', () => {
    // 1h 14m 35s → rounds to 1h 15m
    expect(formatDuration(3600 + 14 * 60 + 35)).toBe('1h 15m');
  });
});
