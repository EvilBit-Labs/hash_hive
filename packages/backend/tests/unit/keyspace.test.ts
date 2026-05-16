/**
 * Unit tests for `calculateAttackKeyspace`.
 *
 * The function maps an attack's hashcat mode + wordlist/rule/mask metadata
 * onto a total keyspace value, returned as a bigint-decimal string because
 * mask-attack keyspaces routinely exceed `Number.MAX_SAFE_INTEGER`. Anything
 * the function can't reason about (unknown mode, missing required input,
 * unknown mask token) must return `null` so the caller falls back to the
 * existing single-task path rather than guessing wrong.
 */
import { describe, expect, test } from 'bun:test';
import { calculateAttackKeyspace } from '../../src/services/keyspace.js';

describe('calculateAttackKeyspace - mode 0 (straight)', () => {
  test('returns wordlist * rules', () => {
    expect(calculateAttackKeyspace({ mode: 0, wordlistRows: 1000, rulelistRows: 10 })).toBe(
      '10000'
    );
  });

  test('treats missing rulelist as 1', () => {
    expect(calculateAttackKeyspace({ mode: 0, wordlistRows: 1000 })).toBe('1000');
  });

  test('treats empty rulelist as 1', () => {
    expect(calculateAttackKeyspace({ mode: 0, wordlistRows: 1000, rulelistRows: 0 })).toBe('1000');
  });

  test('returns null when wordlist is missing', () => {
    expect(calculateAttackKeyspace({ mode: 0 })).toBe(null);
  });
});

describe('calculateAttackKeyspace - mode 1 (combination)', () => {
  test('returns wordlistA * wordlistB', () => {
    expect(
      calculateAttackKeyspace({ mode: 1, wordlistRows: 1000, secondaryWordlistRows: 2000 })
    ).toBe('2000000');
  });

  test('returns null when only one wordlist is supplied', () => {
    expect(calculateAttackKeyspace({ mode: 1, wordlistRows: 1000 })).toBe(null);
    expect(calculateAttackKeyspace({ mode: 1, secondaryWordlistRows: 1000 })).toBe(null);
  });
});

describe('calculateAttackKeyspace - mode 3 (mask)', () => {
  test('all-digit 4-char mask returns 10^4', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?d?d?d?d' })).toBe('10000');
  });

  test('all-lower 4-char mask returns 26^4', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?l?l?l?l' })).toBe('456976');
  });

  test('single ?a token expands to printable ASCII (95 chars)', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?a' })).toBe('95');
  });

  test('literal prefix contributes 1 per position', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: 'password?d' })).toBe('10');
  });

  test('unknown ?-token returns null (refuses to guess)', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '?z' })).toBe(null);
  });

  test('?? is a literal question mark (hashcat escape), contributes 1', () => {
    // `??` -> single literal `?`. `?d` -> 10 candidates. Total: 1 * 10 = 10.
    expect(calculateAttackKeyspace({ mode: 3, mask: '???d' })).toBe('10');
  });

  test('?? at end of mask is accepted as a literal', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: 'pw??' })).toBe('1');
  });

  test('returns null when mask is missing', () => {
    expect(calculateAttackKeyspace({ mode: 3 })).toBe(null);
  });

  test('returns null on empty mask', () => {
    expect(calculateAttackKeyspace({ mode: 3, mask: '' })).toBe(null);
  });

  test('long mask exceeds Number.MAX_SAFE_INTEGER and returns precise decimal string', () => {
    // ?a^12 = 95^12 ~ 5.4e23, well above 2^53 ~ 9e15
    const value = calculateAttackKeyspace({ mode: 3, mask: '?a?a?a?a?a?a?a?a?a?a?a?a' });
    expect(typeof value).toBe('string');
    expect(value).toBe('540360087662636962890625');
  });
});

describe('calculateAttackKeyspace - modes 6 / 7 (hybrid)', () => {
  test('mode 6 (wordlist + mask)', () => {
    expect(calculateAttackKeyspace({ mode: 6, wordlistRows: 1000, mask: '?d?d' })).toBe('100000');
  });

  test('mode 7 (mask + wordlist)', () => {
    expect(calculateAttackKeyspace({ mode: 7, mask: '?d?d', wordlistRows: 1000 })).toBe('100000');
  });

  test('mode 6 returns null without wordlist', () => {
    expect(calculateAttackKeyspace({ mode: 6, mask: '?d?d' })).toBe(null);
  });

  test('mode 6 returns null without mask', () => {
    expect(calculateAttackKeyspace({ mode: 6, wordlistRows: 1000 })).toBe(null);
  });
});

describe('calculateAttackKeyspace - unsupported modes', () => {
  test('mode 99 returns null', () => {
    expect(calculateAttackKeyspace({ mode: 99, wordlistRows: 1000 })).toBe(null);
  });

  test('mode 9 returns null even with full inputs', () => {
    expect(calculateAttackKeyspace({ mode: 9, wordlistRows: 1000, mask: '?d?d' })).toBe(null);
  });
});
