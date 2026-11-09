// The evidence for the `snapshot` and `expect` slices (T1.7). The `.snap` files the runners wrote
// are in the black-box goldens; `policy/expect-shape` observes the runner's own `expect`.
import { isModuleRef } from '@provino/policy'
import type { Golden } from '../../golden.ts'
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'
import { capturedFile, observedOf, oneOf, statusOf } from '../observe.ts'

const SNAP = '__snapshots__/written.test.ts.snap'
const snap = (g: Golden): string => capturedFile(g, SNAP)
/** The text of the entry whose key matches, between its backticks. */
const entry = (g: Golden, key: RegExp): string => {
  const match = new RegExp(`exports\\[\`${key.source}\`\\] = \`([\\s\\S]*?)\`;`).exec(snap(g))
  if (match?.[1] === undefined) throw new Error(`${g.suite} (${g.runner}) has no entry ${key}`)
  return match[1]
}
const exitCode = (g: Golden): unknown => observedOf(g).exitCode

export const snapshotClaims: Claims = {
  'snapshot.header': golden('snapshot-written', { read: (g) => snap(g).split('\n')[0] }),
  // The entries are `${name} ${n}`: the neutral `snapshotKey` both runners' keys follow.
  'snapshot.key': golden('snapshot-written', {
    matches: (g, value) =>
      isModuleRef(value) &&
      value.export === 'snapshotKey' &&
      /exports\[`outer.*inner 1`\]/.test(snap(g)),
  }),
  'snapshot.keyJoin': golden('snapshot-written', {
    read: (g) => /exports\[`outer(.*?)inner 1`\]/.exec(snap(g))?.[1],
  }),
  'snapshot.hintJoin': golden('snapshot-written', {
    read: (g) => /exports\[`outer.*?inner(.*?)hint 1`\]/.exec(snap(g))?.[1],
  }),
  'snapshot.dirName': golden('snapshot-written', {
    matches: (g, value) =>
      typeof observedOf(g).files?.[`${String(value)}/written.test.ts.snap`] === 'string',
  }),
  'snapshot.extension': golden('snapshot-written', {
    matches: (g, value) =>
      typeof observedOf(g).files?.[`__snapshots__/written.test.ts${String(value)}`] === 'string',
  }),
  'snapshot.resolvePath': golden('snapshot-written', {
    // `null`: the default place, next to the test in `__snapshots__`.
    matches: (g, value) => value === null && typeof observedOf(g).files?.[SNAP] === 'string',
  }),
  'snapshot.format.escapeString': golden('snapshot-written', {
    // `'a "quoted" \ string'`: the quotes stay bare unless strings are escaped.
    read: (g) => {
      const text = entry(g, /outer.*?inner 1/)
      return oneOf(text, [
        [false, text.startsWith('"a "quoted"')],
        [true, text.startsWith('"a \\\\"quoted')],
      ])
    },
  }),
  'snapshot.format.printBasicPrototype': golden('snapshot-written', {
    read: (g) => {
      const text = entry(g, /outer.*?inner.*?hint 1/)
      return oneOf(text, [
        [false, text.trimStart().startsWith('{')],
        [true, text.trimStart().startsWith('Object {')],
      ])
    },
  }),
  // Jest has no cap (`null`); Vitest's snapshot state holds 2**27, read from the state itself.
  'snapshot.format.maxOutputLength': golden('snapshot-format'),
  'snapshot.serializers': golden('defaults'),
  'snapshot.obsolete.failCI': golden('snapshot-obsolete-ci', { read: (g) => exitCode(g) !== 0 }),
  'snapshot.obsolete.failLocal': golden('snapshot-obsolete-local', {
    read: (g) => exitCode(g) !== 0,
  }),
  'snapshot.ciUpdate': golden('snapshot-new-ci', {
    // Under CI with nothing in the environment: was the new snapshot written?
    read: (g) => {
      const written = observedOf(g).files?.['__snapshots__/new-ci.test.ts.snap']
      return oneOf(written, [
        ['none', written === null && exitCode(g) === 1],
        ['new', typeof written === 'string'],
      ])
    },
  }),
  'snapshot.updateEnvVar': golden('snapshot-ci', {
    // Under CI with UPDATE_SNAPSHOT=new: written only by a runner that reads the variable.
    read: (g) =>
      typeof observedOf(g).files?.['__snapshots__/ci.test.ts.snap'] === 'string'
        ? 'UPDATE_SNAPSHOT'
        : null,
  }),
  'snapshot.throwErrorBody': golden('snapshot-written', {
    read: (g) => {
      const text = entry(g, /outer.*?inner 2/)
      return oneOf(text, [
        ['message', text === '"boom"'],
        ['error', text === '[Error: boom]'],
      ])
    },
  }),
  // Where an inline snapshot goes when a runner writes it into the test file: indented to the call
  // (Vitest), or at column 0 (Jest, when Prettier isn't there to indent it).
  'snapshot.inline.indent': golden('snapshot/inline-written', {
    read: (g) => {
      const lines = capturedFile(g, 'inline-written.test.ts').split('\n')
      const at = lines.findIndex((line) => line.includes('toMatchInlineSnapshot(`'))
      const next = lines[at + 1]
      if (at === -1 || next === undefined)
        throw new Error(`${g.suite} (${g.runner}) wrote no inline snapshot`)
      const callIndent = /^ */.exec(lines[at] ?? '')?.[0].length ?? 0
      const bodyIndent = /^ */.exec(next)?.[0].length ?? 0
      return oneOf(next, [
        ['column0', bodyIndent === 0],
        ['call', bodyIndent > callIndent],
      ])
    },
  }),
  'snapshot.inline.formatter': pending(
    'T7.11',
    'the formatter is Prettier, which Jest finds from the project and Vitest never runs; no fixture here has it, so the inline writer (T7.11) records one with Prettier installed',
  ),
  // Provino's own key: the dialect's pretty-format and words. `own` pins the ref and the test that
  // loads it.
  'snapshot.printer': each(
    own(
      'packages/dialect-jest/src/runtime/snapshot-printer.test.ts',
      'the policy`s printer ref loads',
      {
        module: import.meta.resolve('@provino/dialect-jest/runtime'),
        export: 'jestSnapshotPrinter',
      },
      'Jest 30.5 pretty-format, its plugin order and its words: the snapshot corpus holds the bytes, this test the ref',
    ),
    own(
      'packages/dialect-vitest/src/runtime/snapshot-printer.test.ts',
      'the policy`s printer ref loads',
      {
        module: import.meta.resolve('@provino/dialect-vitest/runtime'),
        export: 'vitestSnapshotPrinter',
      },
      'the vendored @vitest/pretty-format 5.0.5, its plugin order and its words: the snapshot corpus holds the bytes, this test the ref',
    ),
  ),
}

const shape = golden('expect-shape')

/** The expect corpus's message fixtures: they run Jest's `expect`, an inert expect key's readers. */
const expectMessages = corpus(
  'expect',
  ...['equality', 'promises', 'throws', 'truthiness'].map((name) => `expect/messages/${name}`),
)

export const expectClaims: Claims = {
  'expect.matcherNamespace': pending(
    'D47',
    'no code reads it yet, and the research names no behaviour a run shows ("the namespace in matcher messages and the matcher slot")',
  ),
  'expect.pollFailsOnTimeout': each(
    inert('expect.poll.enabled', false, 'Jest has no expect.poll', expectMessages),
    shape,
  ),
  'expect.diffContextLines': shape,
  'expect.valueFormatter': each(
    own(
      'packages/dialect-jest/src/dialect.test.ts',
      'valueFormatter',
      'pretty-format',
      'the one formatter the type allows',
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'valueFormatter',
      'pretty-format',
      'the one formatter the type allows',
    ),
  ),
  'expect.matcherTable': each(
    own(
      'packages/dialect-jest/src/runtime/expect-table.test.ts',
      'matcherTable',
      { module: import.meta.resolve('@provino/dialect-jest/runtime'), export: 'jestExpectTable' },
      "the dialect's vendored matchers, which the expect corpus holds to every Jest message golden (T7.5)",
    ),
    pending(
      'T7.6',
      "Vitest's matcher table is T7.6's (Phase 2); until then the neutral null stands",
    ),
  ),
  'expect.errorShape': shape,
  'expect.equality.errors': shape,
  'expect.equality.invalidDate': shape,
  'expect.soft': shape,
  'expect.poll.enabled': shape,
  'expect.poll.intervalMs': each(
    inert('expect.poll.enabled', false, 'Jest has no expect.poll', expectMessages),
    shape,
  ),
  'expect.poll.timeoutMs': each(
    inert('expect.poll.enabled', false, 'Jest has no expect.poll', expectMessages),
    shape,
  ),
  'expect.requireAssertions': golden('expect-shape', {
    read: (g) => {
      const status = statusOf(g, 'a test with no assertion')
      return oneOf(status, [
        [false, status === 'passed'],
        [true, status === 'failed'],
      ])
    },
  }),
  'expect.expand': golden('defaults'),
}
