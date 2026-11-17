// The evidence for the `snapshot` and `expect` slices (T1.7). The `.snap` files the runners wrote
// are in the black-box goldens; `policy/expect-shape` observes the runner's own `expect`.
import { isDeepStrictEqual } from 'node:util'
import { jestSnapshotStateView } from '@provino/dialect-jest/runtime'
import type { SnapshotViewMatchOptions, SnapshotViewSource } from '@provino/types'
import type { Golden } from '../../golden.ts'
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'
import { capturedFile, observedOf, oneOf, refTo, statusOf } from '../observe.ts'

const SNAP = '__snapshots__/written.test.ts.snap'
const snap = (g: Golden): string => capturedFile(g, SNAP)
/** The text of the entry whose key matches, between its backticks. */
const entry = (g: Golden, key: RegExp): string => {
  const match = new RegExp(`exports\\[\`${key.source}\`\\] = \`([\\s\\S]*?)\`;`).exec(snap(g))
  if (match?.[1] === undefined) throw new Error(`${g.suite} (${g.runner}) has no entry ${key}`)
  return match[1]
}
const exitCode = (g: Golden): unknown => observedOf(g).exitCode

/** A run's snapshot counts, as its results file holds them. */
const counters = (g: Golden) => g.snapshots?.counters

/** A black-box run's kept stderr. */
const stderrOf = (g: Golden): string => String(observedOf(g).stderr)

/** The `path sha256` lines of every image an `image-snapshot-*` run left, sorted. */
const imageHashes = (g: Golden): string => capturedFile(g, 'image-hashes.txt')

/** The attempt the probe state says is running, which a view's snapshots must be recorded against. */
const PROBE_ATTEMPT = 'probe-attempt-7'

/** What the probe state's `match` answers: `actual` and `expected` differ, so a swap shows. */
const PROBE_MATCH = {
  pass: false,
  count: 2,
  key: 'probe key 2',
  actual: 'the received text',
  expected: 'the stored text',
} as const

/** What the probe state's `fail` answers, a key no argument holds. */
const PROBE_FAIL_KEY = 'probe failed 3'

/** What the probe state was asked: each call's member and arguments, a stack thunk called. */
type ProbeCall =
  | readonly ['match', Omit<SnapshotViewMatchOptions, 'stack'> & { readonly stack?: string }]
  | readonly ['fail', string, string | undefined, string | undefined]
  | readonly ['markCheckedForTest', string]

/** What the probe state was asked. */
type Probe = { readonly source: SnapshotViewSource; readonly calls: ProbeCall[] }

/**
 * A file's snapshot state with nothing behind it, which records what a matcher calls on it and
 * with what, and names `PROBE_ATTEMPT` as the running attempt.
 */
function probeSource(update: SnapshotViewSource['update']): Probe {
  const calls: ProbeCall[] = []
  const source: SnapshotViewSource = {
    added: 0,
    matched: 0,
    unmatched: 0,
    updated: 0,
    // Not the default, so a view that reads no `expand` of its own is told apart.
    expand: true,
    update,
    liveCounters: new Map(),
    snapshotPath: '/p/__snapshots__/a.test.ts.snap',
    serializeFormat: Object.freeze({ escapeString: false }),
    currentTestId: () => PROBE_ATTEMPT,
    match: ({ stack, ...options }) => {
      calls.push(['match', stack === undefined ? options : { ...options, stack: stack() }])
      return PROBE_MATCH
    },
    fail: (testName, testId, key) => {
      calls.push(['fail', testName, testId, key])
      return PROBE_FAIL_KEY
    },
    markCheckedForTest: (testName) => calls.push(['markCheckedForTest', testName]),
    getUncheckedCount: () => 0,
    getUncheckedKeys: () => [],
  }
  return { source, calls }
}

/** Builds what a matcher finds as `this.snapshotState` over a probe, or `undefined` for none. */
export type MatcherStateBuilder = (source: SnapshotViewSource) => object | undefined

/**
 * What a matcher finds as `this.snapshotState` under the policy value: the state itself for
 * `null`, Jest's view for the ref to it, `undefined` for any other value.
 */
const matcherStateUnder =
  (value: unknown): MatcherStateBuilder =>
  (source) => {
    if (value === null) return source
    if (refTo('@provino/dialect-jest/runtime', 'jestSnapshotStateView')(value)) {
      return jestSnapshotStateView(source)
    }
    return undefined
  }

/**
 * Whether jest-image-snapshot 6.5.2 could do with the value's `this.snapshotState` what the
 * recordings show it doing: count its images in the live `_counters` map, read `_updateSnapshot`
 * (the run's mode), and write the four counts back through `merge`.
 */
function imageSnapshotCanRun(value: unknown, update: SnapshotViewSource['update']): boolean {
  const probe = probeSource(update)
  const state = matcherStateUnder(value)(probe.source) as Record<string, unknown> | undefined
  if (state === undefined) return false
  const counts = state._counters
  if (!(counts instanceof Map) || counts !== probe.source.liveCounters) return false
  if (state._updateSnapshot !== update) return false
  Object.assign(state, { added: 1, matched: 2, unmatched: 3, updated: 4 })
  const { added, matched, unmatched, updated } = probe.source
  return added === 1 && matched === 2 && unmatched === 3 && updated === 4
}

/**
 * Whether jest-snapshot 30.5.2's own matchers, called with a custom matcher's `this`, could run on
 * the `this.snapshotState` that `build` makes (index.ts `_toMatchSnapshot`): `match` and `fail`
 * reach the file's state with each of jest-snapshot's arguments where it belongs, the snapshot
 * recorded against the running attempt (which a retry takes back: `custom-snapshot-retry`), and
 * return what the state answered; and `expand`, `snapshotFormat` and `snapshotPath` are the
 * state's.
 */
export function jestSnapshotRunsOn(build: MatcherStateBuilder): boolean {
  const probe = probeSource('new')
  const state = build(probe.source) as Record<string, unknown> | undefined
  if (state === undefined) return false
  const { match, fail } = state
  if (typeof match !== 'function' || typeof fail !== 'function') return false
  const received = { value: 'received' }
  const error = new Error('made at a .resolves call')
  // As `_toMatchSnapshot` calls them (index.ts L344-L349, L376-L384), with the identity Provino's
  // matcher state can't give (`currentTestIdentity` is Jest's), so `undefined`.
  const matched = Reflect.apply(match, state, [
    {
      testName: 'probe name: hint',
      testIdentity: undefined,
      received,
      key: 'probe key',
      inlineSnapshot: undefined,
      isInline: false,
      error: undefined,
      testFailing: false,
    },
  ])
  Reflect.apply(match, state, [
    { testName: 'probe inline', received, inlineSnapshot: 'inline text', isInline: true, error },
  ])
  const failed = Reflect.apply(fail, state, ['probe failed', received, 'probe fail key', undefined])
  // Only the options a view gave a value: an `undefined` it passed on is none.
  const given = probe.calls.map((call) =>
    call[0] === 'match'
      ? [call[0], Object.fromEntries(Object.entries(call[1]).filter(([, v]) => v !== undefined))]
      : call,
  )
  return (
    isDeepStrictEqual(matched, { ...PROBE_MATCH }) &&
    failed === PROBE_FAIL_KEY &&
    isDeepStrictEqual(given, [
      [
        'match',
        {
          testName: 'probe name: hint',
          testId: PROBE_ATTEMPT,
          received,
          key: 'probe key',
          isInline: false,
          testFailing: false,
        },
      ],
      [
        'match',
        {
          testName: 'probe inline',
          testId: PROBE_ATTEMPT,
          received,
          inlineSnapshot: 'inline text',
          isInline: true,
          stack: error.stack,
        },
      ],
      ['fail', 'probe failed', PROBE_ATTEMPT, 'probe fail key'],
    ]) &&
    state.expand === probe.source.expand &&
    state.snapshotFormat === probe.source.serializeFormat &&
    state.snapshotPath === probe.source.snapshotPath
  )
}

/** One `ecosystem/image-snapshot-*` recording, run under the update mode it was recorded in. */
const imageSnapshot = (
  fixture: string,
  update: SnapshotViewSource['update'],
  shows: (g: Golden) => boolean,
) =>
  golden(`ecosystem/image-snapshot-${fixture}`, {
    matches: (g, value) => imageSnapshotCanRun(value, update) && shows(g),
  })

/** One `ecosystem/custom-snapshot-*` recording: a custom matcher over jest-snapshot's matchers. */
const customSnapshot = (fixture: string, shows: (g: Golden) => boolean) =>
  golden(`ecosystem/custom-snapshot-${fixture}`, {
    matches: (g, value) => jestSnapshotRunsOn(matcherStateUnder(value)) && shows(g),
  })
export const snapshotClaims: Claims = {
  'snapshot.header': golden('snapshot-written', { read: (g) => snap(g).split('\n')[0] }),
  // The entries are `${name} ${n}`: the neutral `snapshotKey` both runners' keys follow.
  'snapshot.key': golden('snapshot-written', {
    matches: (g, value) =>
      refTo('@provino/policy/behaviours', 'snapshotKey')(value) &&
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
  // Jest formats the file it writes with the project's Prettier (`snapshot/inline-prettier`: double
  // quotes and no semicolons, from its `.prettierrc`); Vitest's half is T7.11's.
  'snapshot.inline.formatter': each(
    golden('snapshot/inline-prettier', {
      read: (g) => {
        const text = capturedFile(g, 'inline-prettier.test.ts')
        return oneOf(text, [
          ['prettier', text.startsWith('describe("formatted"')],
          ['none', text.startsWith("describe('formatted'")],
        ])
      },
    }),
    pending(
      'T7.11',
      "Vitest never runs Prettier on an inline snapshot; its writer is T7.11's Vitest half, which records it",
    ),
  ),
  // Provino's own key (B23d B1): the writer Jest's goldens hold the edits of. Vitest's is T7.11's.
  'snapshot.inline.writer': each(
    golden('snapshot/inline-written', {
      matches: (g, value) =>
        refTo('@provino/dialect-jest/inline-snapshots', 'jestInlineSnapshotWriter')(value) &&
        capturedFile(g, 'inline-written.test.ts').includes('toMatchInlineSnapshot(`'),
    }),
    pending('T7.11', "Vitest writes inline snapshots too; its writer is T7.11's Vitest half"),
  ),
  // Provino's own key: project data the Jest reader fills from `prettierPath`; `null` in both
  // dialects' own values. The test holds what the writer is handed.
  'snapshot.inline.prettierPath': each(
    own(
      'packages/orchestrator/src/inline-snapshots.test.ts',
      'prettierPath',
      null,
      'project data: the Jest reader resolves `prettierPath`, and the writer is handed what the policy holds',
    ),
    own(
      'packages/orchestrator/src/inline-snapshots.test.ts',
      'prettierPath',
      null,
      "project data, read only by a writer, which Vitest's slice does not have yet",
    ),
  ),
  // Provino's own key (B23d B1): Jest's resolver factory, the one `snapshot/resolver-custom`'s
  // snapshots were written and read through.
  'snapshot.resolverFactory': each(
    golden('snapshot/resolver-custom', {
      matches: (g, value) =>
        refTo('@provino/dialect-jest/runtime', 'jestSnapshotResolver')(value) &&
        typeof observedOf(g).files?.['__snaps__/written.test.ts.snap'] === 'string',
    }),
    pending('T11.16', "Vitest's `resolveSnapshotPath` comes with its config reader"),
  ),
  // Provino's own key (DV96): Jest counts a snapshot file with no test file as removed.
  'snapshot.obsoleteFiles': each(
    golden('cli/report-snapshot-obsolete-file', {
      read: (g) => ((g.snapshots?.counters.filesRemoved ?? 0) > 0 ? 'report' : 'ignore'),
    }),
    pending(
      'T11.16',
      'what Vitest does with a snapshot file no test file has is recorded with its reader',
    ),
  ),
  // Provino's own key (B23e, D128): what a matcher finds as `this.snapshotState`, held to what
  // the `ecosystem/image-snapshot-*` and `ecosystem/custom-snapshot-*` recordings show (each
  // `fixture.json` says what). Each claim builds the matcher's `this.snapshotState` under the value
  // and does with it what the recorded package does, so the neutral `null` and another ref fail.
  'snapshot.contextView': each(
    [
      imageSnapshot('add', 'new', (g) => {
        const written = capturedFile(g, '__snapshots__/counter.test.ts.snap')
        return (
          counters(g)?.added === 4 &&
          imageHashes(g).includes('counter-test-ts-counter-2-snap.png ') &&
          written.includes('exports[`counter 1`]') &&
          written.includes('exports[`counter 3`]')
        )
      }),
      imageSnapshot('match', 'none', (g) => counters(g)?.matched === 1),
      imageSnapshot(
        'mismatch',
        'none',
        (g) =>
          counters(g)?.unmatched === 1 &&
          imageHashes(g).includes('__diff_output__/shared-image-diff.png '),
      ),
      imageSnapshot('update', 'all', (g) => counters(g)?.updated === 1),
      imageSnapshot(
        'ci',
        'none',
        (g) =>
          exitCode(g) === 1 &&
          imageHashes(g) === '' &&
          stderrOf(g).includes('New snapshot was not written.'),
      ),
      imageSnapshot('retry', 'new', (g) => {
        const written = capturedFile(g, '__snapshots__/images.test.ts.snap')
        const counts = counters(g)
        return (
          counts?.added === 7 &&
          counts.matched === 3 &&
          written.includes('exports[`image then snapshot 3`]') &&
          written.includes('exports[`snapshot then image 1`]') &&
          written.includes('exports[`snapshot then image 3`]') &&
          imageHashes(g).includes('retry-mixed.png ')
        )
      }),
      customSnapshot(
        'add',
        (g) =>
          counters(g)?.added === 6 &&
          capturedFile(g, '__snapshots__/trimmed.test.ts.snap').includes(
            'exports[`trimmed: toMatchTrimmedSnapshot 1`] = `"extra long"`;',
          ),
      ),
      customSnapshot('match', (g) => exitCode(g) === 0 && counters(g)?.matched === 6),
      customSnapshot('mismatch', (g) => {
        const stderr = stderrOf(g)
        return (
          counters(g)?.unmatched === 2 &&
          stderr.includes('Snapshot name: `trimmed: toMatchTrimmedSnapshot 1`') &&
          stderr.includes('expect(received).toMatchSnapshot(properties)')
        )
      }),
      // jest-snapshot's diff of multi-line values, with the view's `snapshotFormat` (bare quotes)
      // and `expand` (cut to the changed lines, or every line under `--expand`).
      customSnapshot('format', (g) => {
        const stderr = stderrOf(g)
        return (
          counters(g)?.unmatched === 2 &&
          stderr.includes('+   "quote": "say "bye"",') &&
          !stderr.includes('"item 0",')
        )
      }),
      customSnapshot('format-expand', (g) => {
        const stderr = stderrOf(g)
        return stderr.includes('"item 0",') && stderr.includes('"item 19",')
      }),
      customSnapshot('inline', (g) =>
        capturedFile(g, 'inline.test.ts').includes('toMatchTrimmedInlineSnapshot(`"extra long"`)'),
      ),
      customSnapshot(
        'inline-write',
        (g) =>
          counters(g)?.added === 3 &&
          capturedFile(g, 'inline.test.ts').includes(
            'toMatchTrimmedInlineSnapshot(`"second, tr"`)',
          ),
      ),
      // Through `expect` inside custom matchers: written into the innermost matcher's body.
      customSnapshot('inline-nested', (g) => {
        const setup = capturedFile(g, 'setup.ts')
        return (
          counters(g)?.added === 3 &&
          setup.includes('toMatchTrimmedInlineSnapshot(`"LOUD STRIN"`)') &&
          setup.includes('toMatchInlineSnapshot(`"deeper!"`)') &&
          !capturedFile(g, 'nested.test.ts').includes('`')
        )
      }),
      // A retried attempt's snapshots, taken through `match` and `fail`, are taken back: under
      // `--ci` the retry's keys are the stored ones and match, and a first run stores each once.
      customSnapshot('retry', (g) => {
        const counts = counters(g)
        return exitCode(g) === 0 && counts?.matched === 5 && counts.unmatched === 0
      }),
      customSnapshot('retry-new', (g) => {
        const written = capturedFile(g, '__snapshots__/retried.test.ts.snap')
        return (
          exitCode(g) === 0 &&
          counters(g)?.added === 5 &&
          written.includes('exports[`trimmed, then fails once: toMatchTrimmedSnapshot 2`]') &&
          !written.includes('toMatchTrimmedSnapshot 3`]')
        )
      }),
    ],
    pending('T7.6', "what Vitest's matchers read of `this.snapshotState` comes with its table"),
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
  // jest-circus resets the counters only at `test_done`, so what a module scope, a beforeAll or an
  // afterAll counted reaches the next test that ends (jestAdapterInit.ts L362-367): the first test
  // reports its own assertion and the module-scope one.
  'expect.outsideTestCounts': each(
    golden('expect/policies/assertions-outside-test', {
      read: (g) => {
        const passes = g.files
          .flatMap((file) => file.tests)
          .find(
            (t) => t.id.path.join(' › ') === 'takes the module-scope assertion',
          )?.passingAssertions
        return oneOf(passes, [
          ['drop', passes === 1],
          ['next-test', passes === 2],
        ])
      },
    }),
    pending('T11.16', "Vitest's counters aren't recorded: the neutral `drop` stands"),
  ),
}
