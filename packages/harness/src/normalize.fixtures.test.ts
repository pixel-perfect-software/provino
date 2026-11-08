// T12.2: every normalization rule has at least 3 fixture cases, input to output, and each case
// shows its rule in `fired`. The inputs are read from the sample's recording
// (`sample/__recorded__`, real Jest 30.5.2 and Vitest 5.0.5 output with the machine's paths
// rewritten to `/__root__`), so a rule is proved on text a runner printed. `windows-separators`
// can't fire on the POSIX machine that recorded it, so its cases are written by hand and say so.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { consoleLines } from './internal/convert.ts'
import { type NormalizeContext, normalizeText, rules } from './normalize.ts'
import { parseJestJson, parseVitestJson } from './parse-results.ts'
import { parseSidecar } from './sidecar.ts'

const RECORDED = path.join(import.meta.dirname, '..', 'sample', '__recorded__')
const CTX: NormalizeContext = { rootDir: '/__root__' }

type Runner = 'jest' | 'vitest'

/** Where a case's input comes from. */
type From =
  /** A failure message of a test, by file and title path (dupIndex 0). */
  | { readonly runner: Runner; readonly file: string; readonly test: readonly string[] }
  /** Jest's file-level message (`testResults[].message`), which carries code frames. */
  | { readonly runner: 'jest'; readonly fileMessage: string }
  /** A sidecar entry's text, or one line of it, as recorded for the file. */
  | { readonly runner: Runner; readonly console: string; readonly text: string }
  /** Text no recording can hold, with the reason. */
  | { readonly handWritten: string; readonly why: string; readonly ctx: NormalizeContext }

interface Case {
  readonly rule: string
  readonly from: From
  readonly output: string
}

const N = 'normalization-inputs.test.ts'
const RULES_FOR = ['text the normalization rules exist for']
const WINDOWS = 'the recording was made on POSIX, where no path has a drive letter'

const CASES: readonly Case[] = [
  // ansi
  {
    rule: 'ansi',
    from: { runner: 'jest', file: N, test: [...RULES_FOR, 'colour codes'] },
    output: 'Error: red and bold\nat <root>/normalization-inputs.test.ts:10:11',
  },
  {
    rule: 'ansi',
    from: { runner: 'vitest', file: N, test: [...RULES_FOR, 'colour codes'] },
    output: 'Error: red and bold\nat <root>/normalization-inputs.test.ts:10:11',
  },
  {
    rule: 'ansi',
    from: { runner: 'jest', console: N, text: '\u001b[32mgreen\u001b[39m' },
    output: 'green',
  },
  {
    rule: 'ansi',
    from: { runner: 'vitest', console: N, text: '\u001b[32mgreen\u001b[39m' },
    output: 'green',
  },
  // crlf
  {
    rule: 'crlf',
    from: { runner: 'jest', file: N, test: [...RULES_FOR, 'CRLF line ends'] },
    output: 'Error: first line\nsecond line\nat <root>/normalization-inputs.test.ts:14:11',
  },
  {
    rule: 'crlf',
    from: { runner: 'vitest', file: N, test: [...RULES_FOR, 'CRLF line ends'] },
    output: 'Error: first line\nsecond line\nat <root>/normalization-inputs.test.ts:14:11',
  },
  {
    rule: 'crlf',
    from: { runner: 'jest', console: N, text: 'windows line\r\nend' },
    output: 'windows line\nend',
  },
  // file-url
  {
    rule: 'file-url',
    from: { runner: 'jest', file: N, test: [...RULES_FOR, 'a file URL'] },
    output:
      'Error: see <root>/normalization-inputs.test.ts\nat <root>/normalization-inputs.test.ts:18:11',
  },
  {
    rule: 'file-url',
    from: { runner: 'vitest', file: N, test: [...RULES_FOR, 'a file URL'] },
    output:
      'Error: see <root>/normalization-inputs.test.ts\nat <root>/normalization-inputs.test.ts:18:11',
  },
  {
    rule: 'file-url',
    from: { runner: 'jest', console: N, text: 'url file:///__root__/normalization-inputs.test.ts' },
    output: 'url <root>/normalization-inputs.test.ts',
  },
  {
    // Vitest prints its own frames as file URLs, so every Vitest stack fires the rule.
    rule: 'file-url',
    from: { runner: 'vitest', file: 'fail.test.ts', test: ['failing assertions', 'toBe'] },
    output: 'AssertionError: expected 3 to be 4 // Object.is equality\nat <root>/fail.test.ts:3:19',
  },
  // root
  {
    rule: 'root',
    from: { runner: 'jest', file: 'fail.test.ts', test: ['failing assertions', 'toBe'] },
    output:
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 4\nReceived: 3\nat <root>/fail.test.ts:3:19',
  },
  {
    rule: 'root',
    from: {
      runner: 'vitest',
      file: 'fail.test.ts',
      test: ['failing assertions', 'toThrow with the wrong message'],
    },
    output:
      "AssertionError: expected [Function] to throw error including 'fizzle' but got 'kaboom'\nat <root>/fail.test.ts:13:8",
  },
  {
    rule: 'root',
    from: {
      runner: 'vitest',
      console: N,
      text: 'url file:///__root__/normalization-inputs.test.ts',
    },
    output: 'url <root>/normalization-inputs.test.ts',
  },
  // windows-separators: written by hand
  {
    rule: 'windows-separators',
    from: {
      handWritten: 'failed in C:\\work\\fixture\\src\\a.ts',
      why: WINDOWS,
      ctx: { rootDir: 'C:\\work\\fixture' },
    },
    output: 'failed in <root>/src/a.ts',
  },
  {
    rule: 'windows-separators',
    from: { handWritten: 'cannot read D:\\other\\b.ts', why: WINDOWS, ctx: CTX },
    output: 'cannot read D:/other/b.ts',
  },
  {
    rule: 'windows-separators',
    from: {
      handWritten: 'see C:\\work\\fixture\\x\\y.ts and E:\\z\\w.ts',
      why: WINDOWS,
      ctx: { rootDir: 'C:\\work\\fixture' },
    },
    output: 'see <root>/x/y.ts and E:/z/w.ts',
  },
  // code-frames: Jest's file-level messages, and the received error inside a toThrow failure
  {
    rule: 'code-frames',
    from: { runner: 'jest', fileMessage: 'crash.test.ts' },
    output:
      "● Test suite failed to run\n\n    Cannot find module './does-not-exist.ts' from 'crash.test.ts'\nat <root>/crash.test.ts:2:1",
  },
  {
    rule: 'code-frames',
    from: { runner: 'jest', fileMessage: 'failing.test.ts' },
    output:
      '● passes, so it fails\n\n    Failing test passed even though it was supposed to fail. Remove `.failing` to remove error.\nat <root>/failing.test.ts:8:1',
  },
  {
    rule: 'code-frames',
    from: { runner: 'jest', fileMessage: 'each.test.ts' },
    output:
      '● it.each over an array › 2 + 3 = 6\n\n    expect(received).toBe(expected) // Object.is equality\n\n    Expected: 6\n    Received: 5\nat <root>/each.test.ts:6:19',
  },
  {
    rule: 'code-frames',
    from: {
      runner: 'jest',
      file: 'fail.test.ts',
      test: ['failing assertions', 'toThrow with the wrong message'],
    },
    output:
      'Error: expect(received).toThrow(expected)\n\nExpected substring: "fizzle"\nReceived message:   "kaboom"\nat <root>/fail.test.ts:12:13',
  },
  // durations
  {
    rule: 'durations',
    from: { runner: 'jest', file: N, test: [...RULES_FOR, 'a duration'] },
    output: 'Error: the step took (<dur>)\nat <root>/normalization-inputs.test.ts:34:11',
  },
  {
    rule: 'durations',
    from: { runner: 'vitest', file: N, test: [...RULES_FOR, 'a duration'] },
    output: 'Error: the step took (<dur>)\nat <root>/normalization-inputs.test.ts:34:11',
  },
  {
    rule: 'durations',
    from: { runner: 'jest', console: N, text: 'done (3 ms)' },
    output: 'done (<dur>)',
  },
  {
    rule: 'durations',
    from: { runner: 'vitest', console: N, text: 'done (3 ms)' },
    output: 'done (<dur>)',
  },
  // placeholders: a UUID, a hex address, a temp path
  {
    rule: 'placeholders',
    from: { runner: 'jest', file: N, test: [...RULES_FOR, 'a UUID'] },
    output: 'Error: request <uuid> failed\nat <root>/normalization-inputs.test.ts:22:11',
  },
  {
    rule: 'placeholders',
    from: { runner: 'vitest', file: N, test: [...RULES_FOR, 'a hex address'] },
    output: 'Error: segfault at <addr>\nat <root>/normalization-inputs.test.ts:26:11',
  },
  {
    rule: 'placeholders',
    from: { runner: 'jest', file: N, test: [...RULES_FOR, 'a temp path'] },
    output: 'Error: cannot write <tmp>/report.json\nat <root>/normalization-inputs.test.ts:30:11',
  },
  {
    rule: 'placeholders',
    from: {
      runner: 'vitest',
      console: N,
      text: 'id 123e4567-e89b-12d3-a456-426614174000 at 0x00007ffd5e8c1a40',
    },
    output: 'id <uuid> at <addr>',
  },
  {
    rule: 'placeholders',
    from: { runner: 'jest', console: N, text: 'wrote /tmp/x/out.txt' },
    output: 'wrote <tmp>/out.txt',
  },
  // stack: the first user frame is kept, the rest of the stack goes
  {
    rule: 'stack',
    from: {
      runner: 'jest',
      file: 'fail.test.ts',
      test: ['failing throws', 'an error with a cause'],
    },
    output: 'Error: outer\n\n[cause]: Error: inner\nat <root>/fail.test.ts:27:11',
  },
  {
    rule: 'stack',
    from: {
      runner: 'vitest',
      file: 'fail.test.ts',
      test: ['failing throws', 'an error with a cause'],
    },
    output: 'Error: outer\nat <root>/fail.test.ts:27:11',
  },
  {
    rule: 'stack',
    from: {
      runner: 'jest',
      file: 'hooks.test.ts',
      test: ['a failing beforeEach', 'fails before its body runs'],
    },
    output: 'Error: beforeEach failed\nat <root>/hooks.test.ts:17:11',
  },
]

const raws = {
  jest: parseJestJson(readFileSync(path.join(RECORDED, 'jest.raw.json'), 'utf8')),
  vitest: parseVitestJson(readFileSync(path.join(RECORDED, 'vitest.raw.json'), 'utf8')),
}
const sidecars = {
  jest: parseSidecar(readFileSync(path.join(RECORDED, 'jest.console.jsonl'), 'utf8')),
  vitest: parseSidecar(readFileSync(path.join(RECORDED, 'vitest.console.jsonl'), 'utf8')),
}

function fileOf(runner: Runner, file: string) {
  const found = raws[runner].testResults.find((f) => f.name === `/__root__/${file}`)
  assert.ok(found, `${runner} recorded no ${file}`)
  return found
}

function inputOf(from: From): string {
  if ('handWritten' in from) return from.handWritten
  if ('fileMessage' in from) return fileOf(from.runner, from.fileMessage).message
  if ('console' in from) {
    const texts = sidecars[from.runner]
      .filter((entry) => entry.file === `/__root__/${from.console}`)
      .flatMap((entry) => [entry.text, ...consoleLines(entry.text)])
    assert.ok(
      texts.includes(from.text),
      `${from.runner} recorded no console text ${JSON.stringify(from.text)}`,
    )
    return from.text
  }
  const found = fileOf(from.runner, from.file).assertionResults.find(
    (a) => JSON.stringify([...a.ancestorTitles, a.title]) === JSON.stringify(from.test),
  )
  const message = found?.failureMessages?.[0]
  assert.ok(
    typeof message === 'string',
    `${from.runner} recorded no failure for ${from.test.join(' › ')}`,
  )
  return message
}

function label(from: From): string {
  if ('handWritten' in from) return `by hand (${from.why}): ${JSON.stringify(from.handWritten)}`
  if ('fileMessage' in from) return `${from.runner} file message of ${from.fileMessage}`
  if ('console' in from)
    return `${from.runner} console of ${from.console}: ${JSON.stringify(from.text)}`
  return `${from.runner} ${from.file} › ${from.test.join(' › ')}`
}

for (const { rule, from, output } of CASES) {
  test(`${rule}: ${label(from)}`, () => {
    const fired = new Set<string>()
    const ctx = 'handWritten' in from ? from.ctx : CTX
    assert.equal(normalizeText(inputOf(from), ctx, fired), output)
    assert.ok(fired.has(rule), `${rule} did not fire (fired: ${[...fired].join(', ')})`)
  })
}

test('every rule has at least 3 fixture cases, and no case names an unknown rule', () => {
  const ids = rules.map((r) => r.id)
  for (const id of ids) {
    const count = CASES.filter((c) => c.rule === id).length
    assert.ok(count >= 3, `${id} has ${count} cases`)
  }
  for (const c of CASES) assert.ok(ids.includes(c.rule), c.rule)
})

test('only windows-separators is written by hand; every other case reads the recording', () => {
  const byHand = new Set(CASES.filter((c) => 'handWritten' in c.from).map((c) => c.rule))
  assert.deepEqual([...byHand], ['windows-separators'])
})
