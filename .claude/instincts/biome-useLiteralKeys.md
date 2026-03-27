---
id: hashhive-biome-literal-keys
trigger: "when configuring Biome or accessing properties on index-signature types"
confidence: 0.95
domain: biome-config
source: local-repo-analysis
---

# Keep useLiteralKeys Off

## Action

Never enable `useLiteralKeys` in biome.json. It conflicts with TypeScript's `noPropertyAccessFromIndexSignature`.

Always use bracket notation for index-signature access:

```typescript
// With noPropertyAccessFromIndexSignature: true
const val = body['key'];  // GOOD
const val = body.key;     // BAD — TS error on index signatures
```

## Evidence

- `noPropertyAccessFromIndexSignature: true` in tsconfig.base.json
- `useLiteralKeys: "off"` in biome.json
- Enabling it creates an irreconcilable conflict between Biome wanting `obj.key` and TS requiring `obj['key']`
