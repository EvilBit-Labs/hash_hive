import { describe, expect, mock, test } from 'bun:test'

/**
 * Helper: create a ReadableStream from a string (simulates an S3 GetObject body).
 */
function stringToReadableStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

// `fileContent === null` simulates a download with no readable body (a storage
// failure the util must surface, not silently treat as empty).
let fileContent: string | null = ''
const mockDownloadFile = mock((_key: string, _bucket?: string) =>
  Promise.resolve({
    Body:
      fileContent === null
        ? undefined
        : { transformToWebStream: () => stringToReadableStream(fileContent as string) },
  })
)
mock.module('../../../src/config/storage.js', () => ({
  downloadFile: mockDownloadFile,
}))

const {
  countLines,
  countLinesInText,
  countsAsRuleLine,
  countsAsWordlistLine,
  MAX_LINE_LENGTH,
  splitTextLines,
  streamLines,
} = await import('../../../src/services/resources/line-count.js')

async function collect(key: string): Promise<string[]> {
  const out: string[] = []
  for await (const line of streamLines(key)) out.push(line)
  return out
}

describe('streamLines', () => {
  test('yields each newline-delimited segment', async () => {
    fileContent = 'alpha\nbravo\ncharlie'
    expect(await collect('k')).toEqual(['alpha', 'bravo', 'charlie'])
  })

  test('a trailing newline does not produce a phantom empty final line', async () => {
    fileContent = 'alpha\nbravo\n'
    expect(await collect('k')).toEqual(['alpha', 'bravo'])
  })

  test('a no-trailing-newline final line is yielded exactly once', async () => {
    fileContent = 'only-line'
    expect(await collect('k')).toEqual(['only-line'])
  })

  test('interior blank lines are preserved', async () => {
    fileContent = 'alpha\n\nbravo'
    expect(await collect('k')).toEqual(['alpha', '', 'bravo'])
  })

  test('an empty object yields nothing', async () => {
    fileContent = ''
    expect(await collect('k')).toEqual([])
  })

  test('throws when the object has no readable body', async () => {
    fileContent = null
    await expect(collect('missing')).rejects.toThrow(/no file body/i)
  })
})

describe('countLines', () => {
  test('wordlist predicate counts every within-cap line, blanks included', async () => {
    fileContent = 'password\n123456\n\nletmein'
    expect(await countLines('k', countsAsWordlistLine)).toBe(4)
  })

  test('rule predicate excludes blank lines and # comments', async () => {
    fileContent = '# best64-ish\nc\n\n$1\n  \n:'
    // Effective rules: c, $1, : -> 3 (comment, two blanks excluded).
    expect(await countLines('k', countsAsRuleLine)).toBe(3)
  })

  test('respects the length cap (skips an over-cap line)', async () => {
    fileContent = ['short', 'x'.repeat(MAX_LINE_LENGTH + 1), 'alsoshort'].join('\n')
    expect(await countLines('k', countsAsWordlistLine)).toBe(2)
  })

  test('an empty object counts to 0', async () => {
    fileContent = ''
    expect(await countLines('k', countsAsWordlistLine)).toBe(0)
  })

  test('a no-trailing-newline final line is counted once', async () => {
    fileContent = 'a\nb\nc'
    expect(await countLines('k', countsAsWordlistLine)).toBe(3)
  })
})

describe('splitTextLines (in-memory, direct-upload path)', () => {
  test('matches streamLines segment semantics', () => {
    expect([...splitTextLines('alpha\nbravo\ncharlie')]).toEqual(['alpha', 'bravo', 'charlie'])
    expect([...splitTextLines('alpha\nbravo\n')]).toEqual(['alpha', 'bravo']) // no phantom line
    expect([...splitTextLines('alpha\n\nbravo')]).toEqual(['alpha', '', 'bravo']) // interior blank
    expect([...splitTextLines('only')]).toEqual(['only'])
    expect([...splitTextLines('')]).toEqual([])
  })
})

describe('countLinesInText (in-memory, direct-upload path)', () => {
  test('wordlist predicate counts every within-cap line, blanks included', () => {
    expect(countLinesInText('password\n123456\n\nletmein', countsAsWordlistLine)).toBe(4)
  })

  test('rule predicate excludes blank lines and # comments', () => {
    expect(countLinesInText('# rules\nc\n\n$1\n  \n:', countsAsRuleLine)).toBe(3)
  })

  test('respects the length cap', () => {
    const text = ['short', 'x'.repeat(MAX_LINE_LENGTH + 1), 'alsoshort'].join('\n')
    expect(countLinesInText(text, countsAsWordlistLine)).toBe(2)
  })

  test('a no-trailing-newline final line is counted once; empty string is 0', () => {
    expect(countLinesInText('a\nb\nc', countsAsWordlistLine)).toBe(3)
    expect(countLinesInText('', countsAsWordlistLine)).toBe(0)
  })
})

describe('line predicates', () => {
  test('countsAsWordlistLine accepts everything, including blanks', () => {
    expect(countsAsWordlistLine('password')).toBe(true)
    expect(countsAsWordlistLine('')).toBe(true)
  })

  test('countsAsRuleLine excludes blanks and comments, accepts real rules', () => {
    expect(countsAsRuleLine('c')).toBe(true)
    expect(countsAsRuleLine('$1$2$3')).toBe(true)
    expect(countsAsRuleLine('# comment')).toBe(false)
    expect(countsAsRuleLine('   ')).toBe(false)
    expect(countsAsRuleLine('')).toBe(false)
  })
})
