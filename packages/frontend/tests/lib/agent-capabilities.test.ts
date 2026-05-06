import { describe, expect, test } from 'bun:test';
import { formatPrimaryEngine, getPrimaryEngine } from '../../src/lib/agent-capabilities';

describe('getPrimaryEngine', () => {
  test('returns null for null/undefined capabilities', () => {
    expect(getPrimaryEngine(null)).toBeNull();
    expect(getPrimaryEngine(undefined)).toBeNull();
  });

  test('returns null when neither engines[] nor hashcatVersion is present', () => {
    expect(getPrimaryEngine({})).toBeNull();
    expect(getPrimaryEngine({ gpuDevices: [] })).toBeNull();
  });

  test('returns the first engine when engines[] is populated', () => {
    const caps = {
      engines: [
        { name: 'hashcat', version: '6.2.6' },
        { name: 'john', version: '1.9.0-jumbo-1' },
      ],
    };
    expect(getPrimaryEngine(caps)).toEqual({ name: 'hashcat', version: '6.2.6' });
  });

  test('falls back to hashcatVersion when engines[] is empty', () => {
    const caps = { engines: [], hashcatVersion: '6.2.5' };
    expect(getPrimaryEngine(caps)).toEqual({ name: 'hashcat', version: '6.2.5' });
  });

  test('falls back to hashcatVersion when engines[] is missing', () => {
    const caps = { hashcatVersion: '6.2.6' };
    expect(getPrimaryEngine(caps)).toEqual({ name: 'hashcat', version: '6.2.6' });
  });

  test('skips malformed engines[] entries and falls back to hashcatVersion', () => {
    const caps = {
      engines: [{ name: 42, version: null }],
      hashcatVersion: '6.2.6',
    };
    expect(getPrimaryEngine(caps)).toEqual({ name: 'hashcat', version: '6.2.6' });
  });

  test('rejects empty hashcatVersion strings', () => {
    expect(getPrimaryEngine({ hashcatVersion: '' })).toBeNull();
  });
});

describe('formatPrimaryEngine', () => {
  test('renders ASCII dash for null engine', () => {
    // ASCII placeholder per the project's UI text guideline (no Unicode
    // em/en dashes in dashboard text).
    expect(formatPrimaryEngine(null)).toBe('-');
  });

  test('renders name + version', () => {
    expect(formatPrimaryEngine({ name: 'hashcat', version: '6.2.6' })).toBe('hashcat 6.2.6');
  });
});
