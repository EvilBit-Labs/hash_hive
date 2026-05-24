import { describe, expect, it } from 'bun:test'

import { advancedConfigSchema, attackFormSchema } from '../../src/lib/attack-schemas'

describe('advancedConfigSchema', () => {
  it('returns undefined for missing input', () => {
    const result = advancedConfigSchema.safeParse(undefined)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    const result = advancedConfigSchema.safeParse('')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBeUndefined()
  })

  it('returns undefined for whitespace-only input', () => {
    const result = advancedConfigSchema.safeParse('   \n\t  ')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBeUndefined()
  })

  it('parses a valid JSON object', () => {
    const result = advancedConfigSchema.safeParse('{"workload-profile": 3}')
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ 'workload-profile': 3 })
  })

  it('rejects invalid JSON with a clear message', () => {
    const result = advancedConfigSchema.safeParse('not json')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toBe('Must be valid JSON')
  })

  it('rejects a JSON array (hashcat config must be an object, not a list)', () => {
    const result = advancedConfigSchema.safeParse('[1, 2, 3]')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain('JSON object')
  })

  it('rejects a JSON null', () => {
    const result = advancedConfigSchema.safeParse('null')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain('JSON object')
  })

  it('rejects a JSON primitive (string)', () => {
    const result = advancedConfigSchema.safeParse('"just a string"')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain('JSON object')
  })

  it('rejects a JSON primitive (number)', () => {
    const result = advancedConfigSchema.safeParse('42')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toContain('JSON object')
  })
})

describe('attackFormSchema', () => {
  it('coerces a string mode into a number', () => {
    const result = attackFormSchema.safeParse({ mode: '3' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.mode).toBe(3)
  })

  it('rejects a negative mode', () => {
    const result = attackFormSchema.safeParse({ mode: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects a non-numeric string mode', () => {
    const result = attackFormSchema.safeParse({ mode: 'abc' })
    expect(result.success).toBe(false)
  })

  it('treats empty optional resource IDs as undefined', () => {
    const result = attackFormSchema.safeParse({
      mode: 0,
      wordlistId: '',
      rulelistId: null,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.wordlistId).toBeUndefined()
    expect(result.data.rulelistId).toBeUndefined()
  })

  it('parses an advancedConfiguration JSON object at the schema level', () => {
    const result = attackFormSchema.safeParse({
      mode: 0,
      advancedConfiguration: '{"foo": "bar"}',
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.advancedConfiguration).toEqual({ foo: 'bar' })
  })
})
