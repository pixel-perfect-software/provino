// `recorder-text.ts` is a hand copy of the harness's text normalizer (`normalize.ts`
// `createNormalizer(...).text`, with `internal/stack.ts` and `internal/paths.ts`). This holds the
// copy to the original on the same varied inputs, so a change to one that misses the other fails
// here. The harness is loaded by path, as `watch-goldens.ts` loads its watch pieces: `provino` may
// not import `@provino/harness` (the harness depends on it).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { recorderText } from './recorder-text.ts'

interface HarnessNormalizer {
  readonly text: (s: string) => string
}
type CreateNormalizer = (ctx: {
  readonly rootDir: string
  readonly extraRoots?: readonly string[]
}) => HarnessNormalizer

const NORMALIZE = new URL('../../harness/src/normalize.ts', import.meta.url)
const { createNormalizer } = (await import(NORMALIZE.href)) as {
  readonly createNormalizer: CreateNormalizer
}

const ROOT = '/work/fixture'
const OTHER_ROOT = '/private/var/folders/xy/T/provino-abc123'

/** Inputs for each rule the normalizer has, and the shapes they meet in a run's text. */
const INPUTS: readonly string[] = [
  '',
  'plain text with no rule to fire',
  // Frames: a user frame, an internal one, node: and node_modules, an async and an eval frame.
  [
    'Error: boom',
    `    at Object.<anonymous> (${ROOT}/a.test.ts:7:23)`,
    `    at async run (${ROOT}/node_modules/jest-circus/build/run.js:1:2)`,
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    `    at eval (eval at load (${ROOT}/src/x.ts:3:1), <anonymous>:1:1)`,
    '    at native',
  ].join('\n'),
  // A cause chain.
  [
    'Error: outer',
    `    at outer (${ROOT}/src/outer.ts:2:3)`,
    '[cause]: Error: inner',
    `    at inner (${ROOT}/src/inner.ts:5:7)`,
  ].join('\n'),
  // Frame-shaped text inside a message, then the real stack.
  [
    'Expected: "at x (y.ts:1:1)"',
    'Received: "z"',
    `    at Object.toBe (${ROOT}/b.test.ts:4:10)`,
  ].join('\n'),
  // A code frame with a caret, and one without.
  [
    'Error: failed',
    '',
    '  3 | test("x", () => {',
    '> 4 |   expect(1).toBe(2)',
    '    |             ^',
    '  5 | })',
    '',
    `    at Object.toBe (${ROOT}/c.test.ts:4:13)`,
  ].join('\n'),
  ['  1 | const a = 1', '  2 | const b = 2'].join('\n'),
  // Durations and times.
  'PASS ./a.test.ts (12 ms)',
  '  ✓ passes (3 ms)',
  'Time:        1.234 s, estimated 2 s',
  'Time:        0.5 s',
  'a configured timeout of 5000 ms stays',
  // UUIDs, roots, temporary and file URLs.
  'id 123e4567-e89b-12d3-a456-426614174000 and 00000000-0000-0000-0000-000000000000',
  `${ROOT}/src/a.ts and ${ROOT}copy/b.ts and ${ROOT}@1/c.ts`,
  `file://${ROOT}/a.test.ts:1:1 and file:///${ROOT.slice(1)}/b.ts`,
  `${OTHER_ROOT}/x.test.ts:1:1 and /tmp/other/y.ts`,
  // Windows tails and roots.
  'C:\\work\\fixture\\a.test.ts:3:4',
  `${ROOT}\\sub\\a.test.ts:1:1\r\nnext line\r\n`,
  // Colour.
  '\u001b[31mred\u001b[39m and \u001b[1mbold\u001b[22m',
  // A failure that is all of it at once.
  [
    `\u001b[31mFAIL\u001b[39m ${ROOT}/d.test.ts (1.2 s)`,
    '  ● fails',
    '',
    '    expect(received).toBe(expected)',
    '',
    `      at Object.toBe (${ROOT}/d.test.ts:2:3)`,
    `      at ${OTHER_ROOT}/node_modules/x/index.js:9:9`,
  ].join('\r\n'),
]

describe('recorder-text.ts, the copy of the harness’s text normalizer', () => {
  for (const roots of [[ROOT], [ROOT, OTHER_ROOT], ['C:\\work\\fixture']] as const) {
    it(`gives the harness’s output for every input, with roots ${roots.join(', ')}`, () => {
      const [rootDir = '', ...extraRoots] = roots
      const original = createNormalizer({ rootDir, extraRoots })
      const copy = recorderText(roots)
      for (const input of INPUTS) {
        assert.equal(copy(input), original.text(input), `input: ${JSON.stringify(input)}`)
      }
    })
  }

  it('is not a pass-through: the inputs exercise the rules', () => {
    const copy = recorderText([ROOT])
    const changed = INPUTS.filter((input) => copy(input) !== input)
    assert.ok(changed.length >= INPUTS.length - 4, `only ${changed.length} inputs changed`)
  })
})
