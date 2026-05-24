import { describe, expect, test } from 'bun:test'

import { parseProjectIdHeader } from '../../src/lib/headers.js'

describe('parseProjectIdHeader', () => {
  test('returns null for absent header', () => {
    expect(parseProjectIdHeader(undefined)).toBeNull()
    expect(parseProjectIdHeader('')).toBeNull()
  })

  test('returns null for non-positive integers', () => {
    expect(parseProjectIdHeader('0')).toBeNull()
    expect(parseProjectIdHeader('-1')).toBeNull()
  })

  test('returns null for non-integer numerics', () => {
    // Number('1.5') === 1.5 → not isInteger → null
    expect(parseProjectIdHeader('1.5')).toBeNull()
    // Number('1e2') === 100 which IS an integer; the helper accepts it.
    // Documenting so a future reader doesn't reflexively "fix" this.
    expect(parseProjectIdHeader('1e2')).toBe(100)
  })

  test('returns null for non-numeric strings', () => {
    expect(parseProjectIdHeader('abc')).toBeNull()
    expect(parseProjectIdHeader('not-a-number')).toBeNull()
  })

  test('returns null for non-numeric symbols', () => {
    expect(parseProjectIdHeader('NaN')).toBeNull()
    // Number('Infinity') === Infinity → !isInteger
    expect(parseProjectIdHeader('Infinity')).toBeNull()
  })

  test('returns the integer for valid positive ids', () => {
    expect(parseProjectIdHeader('1')).toBe(1)
    expect(parseProjectIdHeader('42')).toBe(42)
    expect(parseProjectIdHeader('999999')).toBe(999999)
  })
})
