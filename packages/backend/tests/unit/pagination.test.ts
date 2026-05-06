import { describe, expect, test } from 'bun:test';
import { paginate, paginationQuerySchema } from '../../src/lib/pagination.js';

describe('paginationQuerySchema', () => {
  test('applies defaults when query is empty', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ offset: 0, limit: 50 });
  });

  test('coerces string-form values', () => {
    expect(paginationQuerySchema.parse({ offset: '10', limit: '25' })).toEqual({
      offset: 10,
      limit: 25,
    });
  });

  test('rejects negative offset', () => {
    expect(paginationQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  test('rejects limit above max', () => {
    expect(paginationQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  test('rejects limit below 1', () => {
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  test('accepts the boundary values', () => {
    expect(paginationQuerySchema.parse({ offset: 0, limit: 200 })).toEqual({
      offset: 0,
      limit: 200,
    });
  });
});

describe('paginate', () => {
  test('returns the items, total, offset, and limit', () => {
    const result = paginate(['a', 'b'], 100, { offset: 5, limit: 2 });
    expect(result).toEqual({ items: ['a', 'b'], total: 100, offset: 5, limit: 2 });
  });

  test('echoes offset past total without modification', () => {
    const result = paginate<string>([], 5, { offset: 999, limit: 50 });
    expect(result).toEqual({ items: [], total: 5, offset: 999, limit: 50 });
  });
});
