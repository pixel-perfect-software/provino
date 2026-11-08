// The evidence for the `snapshot` and `expect` slices (T1.7). The `.snap` files the runners wrote
// are in the black-box goldens; `policy/expect-shape` observes the runner's own `expect`.
import { isModuleRef } from '@provino/policy'
import type { Golden } from '../../golden.ts'
import { type Claims, each, golden, inert, own, pending } from '../evidence.ts'
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
  'snapshot.format.maxOutputLength': each(
    golden('defaults'),
    pending(
      'B17b',
      'a 128 MB cap no recorded run reaches; T7.9 checks it against @vitest/snapshot',
    ),
  ),
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
  'snapshot.inline': pending(
    'B17b',
    'inline snapshots are T7.10s; its fixture records the indent and the formatter',
  ),
}

const shape = golden('expect-shape')

export const expectClaims: Claims = {
  'expect.matcherNamespace': pending(
    'Tyler',
    'no code reads it yet, and the research names no behaviour a run shows ("the namespace in matcher messages and the matcher slot")',
  ),
  'expect.pollFailsOnTimeout': each(
    inert('expect.poll.enabled', false, 'Jest has no expect.poll'),
    shape,
  ),
  'expect.diffContextLines': shape,
  'expect.valueFormatter': each(
    own(
      'packages/dialect-jest/src/dialect.test.ts',
      'valueFormatter',
      'the one formatter the type allows',
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'valueFormatter',
      'the one formatter the type allows',
    ),
  ),
  'expect.matcherTable': each(
    own(
      'packages/harness/src/expect-corpus.test.ts',
      'expect',
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
    inert('expect.poll.enabled', false, 'Jest has no expect.poll'),
    shape,
  ),
  'expect.poll.timeoutMs': each(
    inert('expect.poll.enabled', false, 'Jest has no expect.poll'),
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
