/**
 * Shared line-streaming + line-counting primitives for resource files in
 * object storage. Extracted from the hash-list parser worker so the parser
 * (which counts hash items), the wordlist/rule-list keyspace counter
 * (`services/attacks/complexity.ts`), and the async line-count worker
 * (`queue/workers/line-count.ts`) all share one hardened streaming core
 * rather than reimplementing WebStream + TextDecoder buffer management.
 *
 * The generator yields raw, untrimmed, newline-delimited segments; the
 * length cap, trimming, blank-line handling, and counting are deliberately
 * left to callers, because the three consumers treat blank and over-length
 * lines differently:
 *   - the parser trims, skips blanks, and counts over-cap lines as skipped;
 *   - a wordlist counts every within-cap line (blanks are candidates);
 *   - a rule list counts only effective rules (non-blank, non-comment).
 */

import { downloadFile } from '../../config/storage.js'

/** Skip malformed/binary lines longer than this (bytes ~= chars). */
export const MAX_LINE_LENGTH = 10_000 // 10 KB

/**
 * Stream an object from storage and yield each newline-delimited segment.
 *
 * Segments are raw (not trimmed) and the cap is NOT applied here. The final
 * segment is yielded only when it is non-empty, so a trailing newline does
 * not produce a phantom empty line (`"a\nb\n"` -> `["a","b"]`) while an
 * interior blank line is preserved (`"a\n\nb"` -> `["a","","b"]`). This
 * matches standard line semantics and the parser's prior behavior.
 *
 * @throws if the object has no readable body (a genuine storage failure the
 *   caller should treat as retryable, not as an empty file).
 */
export async function* streamLines(key: string, bucket?: string): AsyncGenerator<string> {
  const response = await downloadFile(key, bucket)
  const body = response.Body
  if (!body) {
    throw new Error(`No file body for storage key ${key}`)
  }

  const stream = body.transformToWebStream()
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode() // flush any buffered multi-byte sequence
        break
      }
      buffer += decoder.decode(value, { stream: true })

      for (
        let newlineIdx = buffer.indexOf('\n');
        newlineIdx !== -1;
        newlineIdx = buffer.indexOf('\n')
      ) {
        yield buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Final segment after the last newline: a real line only when non-empty.
  if (buffer.length > 0) {
    yield buffer
  }
}

/**
 * Count the lines in a storage object that satisfy `predicate`, skipping any
 * segment longer than {@link MAX_LINE_LENGTH} (treated as malformed/binary
 * and never counted, regardless of the predicate). Used to size a wordlist
 * or rule list for keyspace computation.
 */
export async function countLines(
  key: string,
  predicate: (line: string) => boolean,
  bucket?: string
): Promise<number> {
  let count = 0
  for await (const line of streamLines(key, bucket)) {
    if (line.length > MAX_LINE_LENGTH) continue
    if (predicate(line)) count++
  }
  return count
}

/**
 * Split a fully-buffered string into newline-delimited segments, matching
 * {@link streamLines} semantics: interior blanks preserved, no phantom empty
 * line on a trailing newline. Used for the direct-upload path, where the file
 * is already in memory (size-capped) so re-downloading to stream it would be
 * wasteful.
 */
export function* splitTextLines(text: string): Generator<string> {
  let start = 0
  for (let idx = text.indexOf('\n'); idx !== -1; idx = text.indexOf('\n', start)) {
    yield text.slice(start, idx)
    start = idx + 1
  }
  if (start < text.length) yield text.slice(start)
}

/**
 * Count the lines in an in-memory string that satisfy `predicate`, skipping any
 * segment longer than {@link MAX_LINE_LENGTH}. The in-memory twin of
 * {@link countLines}; both apply identical cap + predicate semantics so a
 * resource sized at direct-upload time and one sized by the async worker agree.
 */
export function countLinesInText(text: string, predicate: (line: string) => boolean): number {
  let count = 0
  for (const line of splitTextLines(text)) {
    if (line.length > MAX_LINE_LENGTH) continue
    if (predicate(line)) count++
  }
  return count
}

/**
 * Wordlist sizing predicate: every within-cap line is a candidate, blank
 * lines included (an empty line is an empty-password candidate).
 */
export function countsAsWordlistLine(_line: string): boolean {
  return true
}

/**
 * Rule-list sizing predicate: effective rules only. hashcat ignores blank
 * lines and `#`-prefixed comments, so they must not inflate the rule count
 * that multiplies a wordlist's keyspace.
 */
export function countsAsRuleLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length > 0 && !trimmed.startsWith('#')
}
