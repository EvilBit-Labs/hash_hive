---
id: hashhive-schema-flow
trigger: "when adding or modifying database tables, Zod schemas, or TypeScript types"
confidence: 0.95
domain: architecture
source: local-repo-analysis
---

# Follow the One-Way Schema Flow

## Action

Schema changes flow in ONE direction. Never create types or schemas manually — always derive them.

```
shared/src/db/schema.ts       ← EDIT HERE (Drizzle tables)
    ↓
shared/src/schemas/index.ts   ← Add createInsertSchema/createSelectSchema
    ↓
shared/src/types/index.ts     ← Add z.infer<typeof schema> exports
```

When adding a new table:

1. Add Drizzle table definition in `schema.ts`
2. Add `createInsertSchema(table)` + `createSelectSchema(table)` in `schemas/index.ts`
3. Add `type Insert* = z.infer<...>` + `type Select* = z.infer<...>` in `types/index.ts`
4. Run `bun --filter shared build` to regenerate

These three files ALWAYS change together.

## Evidence

- All 15 database tables follow this exact pattern
- Co-change analysis shows schema.ts, schemas/index.ts, and types/index.ts always modified together
- drizzle-zod generates runtime-safe Zod validators from Drizzle definitions
