import {
  agentConfigSchema,
  agentErrorWhitelistSchema,
  agentHashcatTuningSchema,
  agentTuningSchema,
  effectiveAgentConfigSchema,
  fleetDefaultConfigSchema,
  RAW_FLAGS_MAX_LEN,
  WHITELIST_MAX_ENTRIES,
  WHITELIST_PATTERN_MAX,
} from '@hashhive/shared'
import { describe, expect, it } from 'bun:test'

describe('agentConfigSchema', () => {
  it('parses a full valid config', () => {
    const result = agentConfigSchema.safeParse({
      tuning: { hashcat: { workloadProfile: 3, kernelAccel: 256, rawFlags: '--bitmap-max 24' } },
      hardware: { deviceIds: [1, 2], tempAbort: 90 },
      errorWhitelist: ['No hashes loaded'],
    })
    expect(result.success).toBe(true)
  })

  it('parses an empty config (all-inherited rig)', () => {
    expect(agentConfigSchema.safeParse({}).success).toBe(true)
  })

  it('rejects an unknown engine key (closed tuning shape)', () => {
    const result = agentTuningSchema.safeParse({ john: { workloadProfile: 1 } })
    expect(result.success).toBe(false)
  })

  it('rejects unknown top-level keys', () => {
    expect(agentConfigSchema.safeParse({ bogus: true }).success).toBe(false)
  })
})

describe('agentHashcatTuningSchema workload profile bounds', () => {
  it('accepts the min and max workload profile', () => {
    expect(agentHashcatTuningSchema.safeParse({ workloadProfile: 1 }).success).toBe(true)
    expect(agentHashcatTuningSchema.safeParse({ workloadProfile: 4 }).success).toBe(true)
  })

  it('rejects out-of-range workload profiles', () => {
    expect(agentHashcatTuningSchema.safeParse({ workloadProfile: 0 }).success).toBe(false)
    expect(agentHashcatTuningSchema.safeParse({ workloadProfile: 5 }).success).toBe(false)
  })

  it('rejects raw flags exceeding the length cap', () => {
    const tooLong = 'a'.repeat(RAW_FLAGS_MAX_LEN + 1)
    expect(agentHashcatTuningSchema.safeParse({ rawFlags: tooLong }).success).toBe(false)
  })
})

describe('agentErrorWhitelistSchema', () => {
  it('accepts a pattern at the max length', () => {
    const pattern = 'x'.repeat(WHITELIST_PATTERN_MAX)
    expect(agentErrorWhitelistSchema.safeParse([pattern]).success).toBe(true)
  })

  it('rejects an over-length pattern', () => {
    const pattern = 'x'.repeat(WHITELIST_PATTERN_MAX + 1)
    expect(agentErrorWhitelistSchema.safeParse([pattern]).success).toBe(false)
  })

  it('rejects a non-string entry', () => {
    expect(agentErrorWhitelistSchema.safeParse([123]).success).toBe(false)
  })

  it('rejects more than the max number of entries', () => {
    const entries = Array.from({ length: WHITELIST_MAX_ENTRIES + 1 }, (_, i) => `p${i}`)
    expect(agentErrorWhitelistSchema.safeParse(entries).success).toBe(false)
  })
})

describe('fleetDefaultConfigSchema', () => {
  it('parses tuning + whitelist', () => {
    const result = fleetDefaultConfigSchema.safeParse({
      tuning: { hashcat: { workloadProfile: 2 } },
      errorWhitelist: ['Temperature threshold'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects hardware-bound knobs in the fleet default', () => {
    const result = fleetDefaultConfigSchema.safeParse({ hardware: { tempAbort: 80 } })
    expect(result.success).toBe(false)
  })
})

describe('effectiveAgentConfigSchema', () => {
  it('parses resolved tuning + hardware with no whitelist', () => {
    const result = effectiveAgentConfigSchema.safeParse({
      tuning: { hashcat: { workloadProfile: 3 } },
      hardware: { deviceIds: [1] },
    })
    expect(result.success).toBe(true)
  })
})
