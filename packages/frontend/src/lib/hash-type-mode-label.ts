/**
 * Maps a raw hashcat mode number (e.g. from `SplitReviewGroups` — issue
 * #202 SU6) to a human-readable label using the project's hash-type
 * catalog (`GET /dashboard/resources/hash-types`, keyed by `hashcatMode`).
 *
 * Falls back to `Mode <n>` when the catalog hasn't loaded yet or the mode
 * isn't in it (e.g. a mode hashcat supports but the catalog doesn't list) —
 * the split-review UI must never fail to render because a lookup missed.
 */

interface HashTypeLookupEntry {
  hashcatMode: number
  name: string
}

export function hashTypeModeLabel(mode: number, hashTypes: readonly HashTypeLookupEntry[]): string {
  const match = hashTypes.find((ht) => ht.hashcatMode === mode)
  return match ? `${match.name} (mode ${mode})` : `Mode ${mode}`
}
