/**
 * Canonical resourceType -> Drizzle table map, singular-keyed
 * (`wordlist`/`rulelist`/`masklist`).
 *
 * Extracted because the line-count worker (`line-count.ts`) and the
 * chunked-upload compression worker (`resource-compression.ts`) each
 * independently defined an identical `{ wordlist, rulelist, masklist }`
 * lookup. This is the single source of truth for both; the key type is
 * compatible with `LineCountResourceType` (`line-count-trigger.ts`) and
 * `CompressibleResourceType` (`resource-compression.ts`), both of which
 * are `'wordlist' | 'rulelist' | 'masklist'`.
 *
 * Not to be confused with the plural-keyed `RESOURCE_TYPE_TABLE` in
 * `../resources.ts` (`wordlists`/`rulelists`/`masklists`), which maps
 * the dashboard/agent-facing resourceType string, a different key
 * space entirely.
 */
import { maskLists, ruleLists, wordLists } from '@hashhive/shared'

export const RESOURCE_TABLE_BY_TYPE = {
  wordlist: wordLists,
  rulelist: ruleLists,
  masklist: maskLists,
} as const
