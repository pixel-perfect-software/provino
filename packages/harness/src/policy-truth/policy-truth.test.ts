// T1.7: every value of both dialects is backed by evidence, and the evidence holds (CLAUDE.md
// non-negotiable 2, DECISIONS D27). For each leaf of a dialect's resolved policy (plus its hoisting
// rules and its globals' names): a golden recorded from the real runner shows the value, a corpus
// check fails when the value is flipped, the key is Provino's own and a test pins it, nothing reads
// it under this dialect, or it is pending with its owner. Every flip of a value must be rejected by
// some evidence. No runner starts: the goldens are committed, and `record --check` keeps them
// current.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import type { HoistPolicy } from '@provino/types'
import {
  checkedOnNode,
  defaultFixturesRoot,
  FIXTURE_RUNNERS,
  type FixtureRunner,
  findFixtures,
} from '../fixture.ts'
import { readGolden } from '../golden.ts'
import { FLIPS, type Flip } from '../hoist-corpus/flips.ts'
import { isNodeModules, walkFiles } from '../internal/walk.ts'
import { CLAIMS } from './claims/index.ts'
import {
  captureStrayErrors,
  corpusProblems,
  fixtureById,
  type RunCorpus,
  type StrayErrors,
} from './corpora.ts'
import { type CorpusEvidence, corpus, type Evidence, evidenceFor, inert, own } from './evidence.ts'
import { DOMAINS, flipsOf } from './flip.ts'
import { coveringKey, policyLeaves, withLeaf } from './leaves.ts'
import { observation, observations } from './observe.ts'
import { type DialectSubject, SUBJECTS, subjectLeaves } from './subjects.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const CLAIM_KEYS: ReadonlySet<string> = new Set(Object.keys(CLAIMS))

/**
 * The leaves still pending, by `runner leaf`, with their owner. Pinned, so the list only changes on
 * purpose: a new pending entry fails here until it is added, and one that gains evidence fails
 * until it is removed.
 */
const EXPECTED_PENDING: Readonly<Record<string, string>> = {
  // Behaviour another bundle builds; its first fixture records the value.
  'jest snapshot.inline.formatter': 'T7.11',
  'jest orchestrator.sequence.unknownFirst': 'B21',
  'jest orchestrator.watch.initialRun': 'T9.11',
  'jest orchestrator.inBand.fastFileCount': 'B14',
  'jest orchestrator.inBand.slowMs': 'B14',
  'vitest orchestrator.inBand.fastFileCount': 'B14',
  'vitest orchestrator.inBand.slowMs': 'B14',
  'jest orchestrator.changedFiles': 'B23c-P5',
  'jest orchestrator.affected.extractor': 'B23c-P5',
  'jest orchestrator.affected.mockEdges.dir': 'B23c-P5',
  'jest orchestrator.affected.mockEdges.adjacent': 'B23c-P5',
  'jest orchestrator.affected.mockEdges.byName': 'B23c-P5',
  'jest orchestrator.affected.invalidateAll': 'B23c-P5',
  'jest orchestrator.affected.graph': 'B23c-P5',
  'jest report.resultStatusSkipped': 'T11.8',
  'jest coverage.globThresholdScope': 'T8.9',
  'jest coverage.includeUntestedByDefault': 'T8.9',
  'jest coverage.thresholdGrouping': 'T8.9',
  'jest lazy.readInBeforeAll': 'T6.5',
  'jest coverage.v8Conversion': 'B23b',
  'jest coverage.v8HitCounts': 'B23b',
  'jest coverage.istanbulVariable': 'B23b',
  'jest coverage.thresholdMessages.aboveMaximumUncovered': 'B23b',
  'jest coverage.thresholdMessages.belowMinimum': 'B23b',
  'jest coverage.thresholdMessages.notFound': 'B23b',
  'vitest snapshot.inline.formatter': 'T7.11',
  'vitest hoist.messages.HOIST_EXPORTED': 'T11.16',
  'vitest hoist.messages.HOIST_EXPORTED_VALUE': 'T11.16',
  'vitest hoist.messages.HOIST_NESTED': 'T11.16',
  'vitest hoist.messages.HOIST_NOT_TOP_LEVEL': 'T11.16',
  'vitest mock.messages.spy-namespace': 'T11.16',
  'vitest orchestrator.globalSetup.failure': 'T11.16',
  'vitest orchestrator.globalSetup.teardownOrder': 'T11.16',
  'vitest orchestrator.sequence.unknownFirst': 'B21',
  'vitest orchestrator.todoOnlyFile': 'T11.16',
  'vitest orchestrator.consoleOrigin': 'T11.16',
  'vitest module.stackFrameNames': 'T11.16',
  'vitest orchestrator.processObject': 'T11.16',
  'vitest orchestrator.shard.fallback': 'T11.16',
  'vitest orchestrator.watch.initialRun': 'T9.11',
  'vitest orchestrator.changedFiles': 'T11.16',
  'vitest orchestrator.affected.extractor': 'T11.16',
  'vitest orchestrator.affected.mockEdges.dir': 'T11.16',
  'vitest orchestrator.affected.mockEdges.adjacent': 'T11.16',
  'vitest orchestrator.affected.mockEdges.byName': 'T11.16',
  'vitest orchestrator.affected.invalidateAll': 'T11.16',
  'vitest orchestrator.affected.graph': 'T11.16',
  'vitest report.listTestsForSingleFile': 'T11.16',
  'vitest report.resultStatusSkipped': 'T11.8',
  'vitest coverage.globThresholdScope': 'T8.9',
  'vitest coverage.includeUntestedByDefault': 'T8.9',
  'vitest coverage.thresholdGrouping': 'T8.9',
  'vitest expect.matcherTable': 'T7.6',
  'vitest lazy.readInBeforeAll': 'T6.5',
  'vitest coverage.v8Conversion': 'B25',
  'vitest coverage.v8HitCounts': 'B25',
  'vitest coverage.istanbulVariable': 'B25',
  'vitest coverage.thresholdMessages.aboveMaximumUncovered': 'B25',
  'vitest coverage.thresholdMessages.belowMinimum': 'B25',
  'vitest coverage.thresholdMessages.notFound': 'B25',
  // Core reads it, and no fixture found tells the values apart: a question for Tyler.
  'jest core.concurrency.limitHooks': 'Tyler',
  // No fixture tells the value apart: D47 keeps the research value.
  'jest expect.matcherNamespace': 'D47',
  'jest mock.between.order': 'D47',
  'vitest core.concurrency.limitHooks': 'D47',
  'vitest expect.matcherNamespace': 'D47',
  'vitest mock.between.order': 'D47',
  'vitest orchestrator.watchDefault': 'D47',
}

/** A value as JSON sees it, so a recorded observation and a policy value compare. */
function json(value: unknown): unknown {
  return value === undefined ? { $: 'undefined' } : JSON.parse(JSON.stringify(value))
}

function claimOf(leaf: string): string | undefined {
  return coveringKey(leaf, CLAIM_KEYS)
}

function evidenceOf(leaf: string, runner: FixtureRunner): readonly Evidence[] {
  const key = claimOf(leaf)
  const claim = key === undefined ? undefined : CLAIMS[key]
  return claim === undefined ? [] : evidenceFor(claim, runner)
}

/** Where a path's value is: the hoisting rules, the globals' names, or the resolved policy. */
function valueAt(subject: DialectSubject, path: string): unknown {
  if (path === 'globals.names') return subject.dialect.globals?.names ?? null
  const [root, keys] = path.startsWith('hoist.')
    ? [subject.hoist as unknown, path.slice('hoist.'.length)]
    : [subject.policy as unknown, path]
  return keys
    .split('.')
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root)
}

/** The hoisting leaves a hoist-corpus flip changes, relative to `hoist.`. */
function changedHoistLeaves(base: HoistPolicy, flip: Flip): ReadonlySet<string> {
  const before = policyLeaves(base)
  const after = policyLeaves({ ...base, ...flip.change })
  return new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter(
      (leaf) => !isDeepStrictEqual(before.get(leaf), after.get(leaf)),
    ),
  )
}

/** One corpus run a claim asks for: a fixture under one dialect. */
interface CorpusRun {
  readonly corpus: RunCorpus
  readonly fixture: string
  readonly runner: FixtureRunner
}

const runKey = (run: CorpusRun): string => `${run.corpus} ${run.fixture} ${run.runner}`

/** Every corpus run the claims ask for (a corpus claim's fixtures, an inert claim's readers). */
function corpusRuns(): readonly CorpusRun[] {
  const runs = new Map<string, CorpusRun>()
  for (const runner of FIXTURE_RUNNERS) {
    for (const leaf of subjectLeaves(SUBJECTS[runner]).keys()) {
      for (const piece of evidenceOf(leaf, runner)) {
        const corpus =
          piece.kind === 'corpus' ? piece : piece.kind === 'inert' ? piece.readers : undefined
        if (corpus === undefined || corpus.corpus === 'hoist') continue
        for (const fixture of corpus.fixtures) {
          const run = { corpus: corpus.corpus, fixture, runner }
          runs.set(runKey(run), run)
        }
      }
    }
  }
  return [...runs.values()]
}

/**
 * What each corpus run gives under the dialect's own values, run before any flip: a flipped run can
 * leave a timer or a rejected factory behind, and its error must not land in a baseline. From then
 * on stray errors are recorded and ignored (`captureStrayErrors`); they are never evidence.
 */
const baselines = new Map<string, readonly string[]>()
let stray: StrayErrors | undefined
let strayDuringBaselines: readonly string[] = []

before(async () => {
  stray = captureStrayErrors()
  for (const run of corpusRuns()) {
    if (!checkedOnNode((await fixtureById(run.fixture)).manifest, run.runner)) continue
    const subject = SUBJECTS[run.runner]
    baselines.set(
      runKey(run),
      await corpusProblems(run.corpus, run.fixture, { profile: run.runner, ...subject }),
    )
  }
  // Whatever the baseline runs left behind surfaces within a few macrotasks.
  for (let tick = 0; tick < 3; tick++) await new Promise((resolve) => setImmediate(resolve))
  strayDuringBaselines = [...stray.errors]
})

after(() => stray?.restore())

/** The subject with one leaf flipped. */
function flipped(subject: DialectSubject, leaf: string, value: unknown): DialectSubject {
  if (leaf.startsWith('hoist.')) {
    return { ...subject, hoist: withLeaf(subject.hoist, leaf.slice('hoist.'.length), value) }
  }
  return { ...subject, policy: withLeaf(subject.policy, leaf, value) }
}

/**
 * The fixtures of a corpus evidence recorded under the subject's runner, once each has passed the
 * corpus check under the subject's own values.
 */
async function recordedFixtures(
  evidence: CorpusEvidence,
  subject: DialectSubject,
): Promise<readonly string[]> {
  const name = evidence.corpus
  assert.ok(name !== 'hoist', 'the hoist corpus runs in hoist-corpus.test.ts')
  assert.ok(evidence.fixtures.length > 0, 'a corpus claim names its fixtures')
  const out: string[] = []
  for (const fixture of evidence.fixtures) {
    // A fixture recorded for the other runner only says nothing about this one.
    if (!checkedOnNode((await fixtureById(fixture)).manifest, subject.runner)) continue
    // The dialect's own subject has its baselines from `before`; another (the checks that prove
    // the checks, below) runs its own.
    const baseline: readonly string[] | undefined =
      subject === SUBJECTS[subject.runner]
        ? baselines.get(runKey({ corpus: name, fixture, runner: subject.runner }))
        : await corpusProblems(name, fixture, { profile: subject.runner, ...subject })
    // The dialect's own value must pass the corpus check, or a flip could pass by failing less.
    assert.deepEqual(baseline, [], `${name} ${fixture} fails under the dialect's own value`)
    out.push(fixture)
  }
  assert.ok(out.length > 0, `none of ${evidence.fixtures.join(', ')} is recorded for this dialect`)
  return out
}

/**
 * Checks one piece of evidence for one leaf (whose claim is at `claimKey`), and returns the indexes
 * of the flips it rejects. Own and inert evidence rejects every flip: there is nothing to observe.
 */
async function check(
  evidence: Evidence,
  leaf: string,
  claimKey: string,
  value: unknown,
  flips: readonly unknown[],
  subject: DialectSubject,
  leaves: ReadonlyMap<string, unknown>,
): Promise<ReadonlySet<number>> {
  const all = new Set(flips.map((_, index) => index))
  switch (evidence.kind) {
    case 'golden': {
      const fixture = await fixtureById(evidence.fixture)
      assert.ok(
        fixture.manifest.runners.includes(subject.runner),
        `${evidence.fixture} is not recorded under ${subject.runner}`,
      )
      const golden = await readGolden(fixture.dir, subject.runner)
      const { matches } = evidence
      if (matches !== undefined) {
        assert.ok(matches(golden, value), `${evidence.fixture} doesn't show the value`)
        return new Set([...all].filter((index) => !matches(golden, flips[index])))
      }
      const shown = json(
        evidence.read === undefined
          ? observation(golden, evidence.case ?? leaf)
          : evidence.read(golden),
      )
      assert.deepEqual(shown, json(value), `${evidence.fixture} shows another value`)
      return new Set([...all].filter((index) => !isDeepStrictEqual(shown, json(flips[index]))))
    }
    case 'corpus': {
      if (evidence.corpus === 'hoist') {
        // The hoist corpus runs each of its flips against the real hoisters (D46); one of them
        // must change this very leaf.
        const key = leaf.slice('hoist.'.length)
        assert.ok(
          FLIPS[subject.runner].some((flip) => changedHoistLeaves(subject.hoist, flip).has(key)),
          `hoist-corpus/flips.ts has no ${subject.runner} flip that changes ${key}`,
        )
        return all
      }
      const name = evidence.corpus
      const rejected = new Set<number>()
      for (const fixture of await recordedFixtures(evidence, subject)) {
        for (const [index, flip] of flips.entries()) {
          if (rejected.has(index)) continue
          const problems = await corpusProblems(name, fixture, {
            profile: subject.runner,
            ...flipped(subject, leaf, flip),
          })
          if (problems.length > 0) rejected.add(index)
        }
      }
      // A group claim's corpus may catch flips of only some of its leaves; the test's last check
      // is that some evidence rejects every flip.
      return rejected
    }
    case 'own': {
      assert.deepEqual(
        json(valueAt(subject, claimKey)),
        json(evidence.value),
        `the claim says ${claimKey} is another value than the dialect's`,
      )
      const text = await readFile(path.join(REPO_ROOT, evidence.test), 'utf8')
      assert.ok(
        text.includes(evidence.mentions),
        `${evidence.test} doesn't mention ${evidence.mentions}`,
      )
      return all
    }
    case 'inert': {
      const gates = [...leaves].filter(
        ([path]) => path === evidence.under || path.startsWith(`${evidence.under}.`),
      )
      assert.ok(gates.length > 0, `${evidence.under} is not a leaf or a group`)
      assert.ok(
        evidence.holds(gates.map(([, gate]) => gate)),
        `${evidence.under} doesn't switch ${leaf} off`,
      )
      for (const [gate] of gates) {
        assert.ok(
          evidenceOf(gate, subject.runner).some(
            (other) => other.kind !== 'inert' && other.kind !== 'pending',
          ),
          `${gate} has evidence of its own`,
        )
      }
      // D46: a reader that starts to read the value fails here. Every flip must leave the corpus
      // that runs its would-be readers passing.
      const name = evidence.readers.corpus
      assert.ok(name !== 'hoist', 'an inert value names a corpus that runs here')
      for (const fixture of await recordedFixtures(evidence.readers, subject)) {
        for (const flip of flips) {
          const problems = await corpusProblems(name, fixture, {
            profile: subject.runner,
            ...flipped(subject, leaf, flip),
          })
          assert.deepEqual(
            problems,
            [],
            `${leaf} = ${JSON.stringify(flip)} changed ${fixture}: something reads it`,
          )
        }
      }
      return all
    }
    case 'pending':
      return new Set()
  }
}

/**
 * Whether a leaf with no generic flip (a behaviour ref, a Set, a RegExp) has evidence that can
 * stand without one: a test that pins it, a golden that matches it, a hoist-corpus flip of it, or a
 * domain of one value.
 */
function backedWithoutFlips(leaf: string, evidence: readonly Evidence[]): boolean {
  if (DOMAINS[leaf]?.length === 1) return true
  return evidence.some(
    (piece) =>
      piece.kind === 'own' ||
      (piece.kind === 'golden' && piece.matches !== undefined) ||
      (piece.kind === 'corpus' && piece.corpus === 'hoist'),
  )
}

for (const runner of FIXTURE_RUNNERS) {
  const subject = SUBJECTS[runner]
  const leaves = subjectLeaves(subject)

  describe(`${runner}: ${subject.dialect.name} ${subject.dialect.version}`, () => {
    test('every leaf has evidence', () => {
      assert.deepEqual(
        [...leaves.keys()].filter((leaf) => claimOf(leaf) === undefined),
        [],
        'leaves with no claim',
      )
    })

    test('every enumerated value is in its domain, so its flips are all the others', () => {
      for (const [leaf, values] of Object.entries(DOMAINS)) {
        if (!leaves.has(leaf)) continue
        assert.ok(
          values.includes(leaves.get(leaf) as string),
          `${leaf} = ${String(leaves.get(leaf))}`,
        )
      }
    })

    for (const [leaf, value] of leaves) {
      const evidence = evidenceOf(leaf, runner)
      if (evidence.length === 0 || evidence.every((e) => e.kind === 'pending')) continue
      test(leaf, { timeout: 120_000 }, async () => {
        const flips = flipsOf(leaf, value)
        if (flips.length === 0) {
          assert.ok(backedWithoutFlips(leaf, evidence), 'no flip applies, and no evidence pins it')
        }
        const claimKey = claimOf(leaf) ?? leaf
        const rejected = new Set<number>()
        for (const piece of evidence) {
          for (const index of await check(piece, leaf, claimKey, value, flips, subject, leaves)) {
            rejected.add(index)
          }
        }
        assert.deepEqual(
          flips.filter((_, index) => !rejected.has(index)),
          [],
          'flips no evidence rejects',
        )
      })
    }
  })
}

// The checks above, each shown to catch the hole the pre-merge review found in it (B14a).
describe('the checks catch a wrong value', () => {
  const jest = SUBJECTS.jest
  const jestLeaves = subjectLeaves(jest)

  test('a corpus claim fails when the corpus check fails under the dialect`s own value', async () => {
    // A wrong value whose every flip changes the problems: only the baseline check catches it.
    const leaf = 'core.missingTestFn'
    const [wrong] = flipsOf(leaf, jestLeaves.get(leaf))
    const subject = flipped(jest, leaf, wrong)
    const evidence = corpus('runtime', 'runtime/collection-missing-fn')
    await assert.rejects(
      check(evidence, leaf, leaf, wrong, flipsOf(leaf, wrong), subject, subjectLeaves(subject)),
      /fails under the dialect's own value/,
    )
  })

  test('an inert claim fails when a corpus run reads the value', async () => {
    const leaf = 'core.missingTestFn'
    const value = jestLeaves.get(leaf)
    const evidence = inert(
      'core.eachHooksForConcurrent',
      false,
      'a false claim: the runtime corpus reads it',
      corpus('runtime', 'runtime/collection-missing-fn'),
    )
    await assert.rejects(
      check(evidence, leaf, leaf, value, flipsOf(leaf, value), jest, jestLeaves),
      /something reads it/,
    )
  })

  test('an inert claim fails when any gating leaf stops switching the value off', async () => {
    // Vitest's factory rule is inert while no hoisted method checks a factory, not just `mock`.
    const leaf = 'hoist.factoryReferences'
    const evidence = evidenceOf(leaf, 'vitest').find((piece) => piece.kind === 'inert')
    assert.ok(evidence !== undefined)
    const subject = flipped(SUBJECTS.vitest, 'hoist.hoistCalls.unmock', 'path-factory-options')
    const leaves = subjectLeaves(subject)
    await assert.rejects(
      check(evidence, leaf, leaf, leaves.get(leaf), [], subject, leaves),
      /doesn't switch hoist\.factoryReferences off/,
    )
  })

  test('a hoist claim needs a flip of that very leaf', async () => {
    await assert.rejects(
      check(corpus('hoist'), 'hoist.id', 'hoist.id', 'jest-30.5', [], jest, jestLeaves),
      /no jest flip that changes id/,
    )
    const pureConsts = FLIPS.jest.find((flip) => flip.what === 'no pure consts')
    assert.ok(pureConsts !== undefined)
    assert.deepEqual(
      [...changedHoistLeaves(jest.hoist, pureConsts)],
      ['factoryReferences.hoistPureConsts'],
    )
  })

  test('a leaf no flip applies to needs evidence that pins it', () => {
    const leaf = 'hoist.factoryReferences.allowGlobals'
    assert.equal(backedWithoutFlips(leaf, [corpus('mod', 'mocking/mod-hoist-order')]), false)
    assert.equal(backedWithoutFlips(leaf, [corpus('hoist')]), true)
  })

  test('a formatter claim needs a fixture that titles tests, or the neutral formatter passes', async () => {
    // `.each` titles: the neutral formatter is the only flip, and only a corpus that titles `.each`
    // tests tells it from the runner's (hook order never reaches the formatter).
    const leaf = 'core.formatEachTitle'
    const value = jestLeaves.get(leaf)
    const flips = flipsOf(leaf, value)
    assert.equal(flips.length, 1)
    const rejects = async (fixture: string): Promise<number> =>
      (await check(corpus('runtime', fixture), leaf, leaf, value, flips, jest, jestLeaves)).size
    assert.equal(await rejects('runtime/hook-order'), 0)
    assert.equal(await rejects('runtime/each-tokens'), 1)
  })

  test('an own claim fails when it names another value than the dialect`s', async () => {
    const leaf = 'core.timeouts.teardown'
    const evidence = own('packages/dialect-jest/src/dialect.test.ts', 'timeouts.teardown', 4000, '')
    await assert.rejects(
      check(evidence, leaf, leaf, jestLeaves.get(leaf), [], jest, jestLeaves),
      /another value than the dialect's/,
    )
  })

  test('the scan finds the word in block and JSDoc comments, in any case', () => {
    // Built from the pattern, so this file doesn't spell the word the scan looks for.
    const word = MARKER.source
    const title = `${word.charAt(0).toUpperCase()}${word.slice(1)}`
    for (const line of [`/* ${title}: track-01 */`, ` * ${word.toUpperCase()} until T9.7`]) {
      assert.ok(MARKER.test(line), line)
    }
  })

  test('a runtime corpus run is judged with the corpus check`s expectations, a declared trace included', async () => {
    // Core's run of this fixture differs from the Vitest golden by design (D7): it passes only when
    // `corpusProblems` reads the declaration, as the corpus check does, and fails when the declared
    // trace is not what core gives (here, a policy that changes the retries).
    const vitest = { profile: 'vitest', ...SUBJECTS.vitest } as const
    assert.deepEqual(
      await corpusProblems('runtime', 'runtime/retry-condition-regexp-global', vitest),
      [],
    )
    const dropsKept = await corpusProblems('runtime', 'runtime/retry-condition-regexp-global', {
      ...vitest,
      ...flipped(SUBJECTS.vitest, 'core.retry.keepEarlierErrors', false),
    })
    assert.ok(dropsKept.length > 0, 'a policy that drops the kept errors is not what Vitest does')
  })

  test('an error that escapes a corpus run is not one of its problems', async () => {
    const local = captureStrayErrors()
    try {
      const run = corpusProblems('runtime', 'runtime/collection-missing-fn', {
        profile: 'jest',
        ...jest,
      })
      process.emit('uncaughtException', new Error('left behind by another run'))
      assert.deepEqual(await run, [])
      assert.deepEqual(local.errors, ['left behind by another run'])
    } finally {
      local.restore()
    }
  })
})

test('every corpus run a claim asks for passes under the dialects` own values, with no stray error', () => {
  const failing = [...baselines].filter(([, problems]) => problems.length > 0)
  assert.deepEqual(failing, [])
  assert.ok(baselines.size > 0, 'the claims run corpora')
  assert.deepEqual(strayDuringBaselines, [], 'errors the baseline runs left behind')
})

test('the pending leaves are the pinned list', () => {
  const pending: Record<string, string> = {}
  for (const runner of FIXTURE_RUNNERS) {
    for (const leaf of subjectLeaves(SUBJECTS[runner]).keys()) {
      for (const piece of evidenceOf(leaf, runner)) {
        if (piece.kind === 'pending') pending[`${runner} ${leaf}`] = piece.owner
      }
    }
  }
  assert.deepEqual(pending, EXPECTED_PENDING)
})

test('every claim covers a leaf of a dialect, so none is stale', () => {
  const all = FIXTURE_RUNNERS.flatMap((runner) => [...subjectLeaves(SUBJECTS[runner]).keys()])
  assert.deepEqual(
    [...CLAIM_KEYS].filter(
      (key) => !all.some((leaf) => leaf === key || leaf.startsWith(`${key}.`)),
    ),
    [],
  )
})

test('every observation a policy fixture records for a leaf agrees with the dialect', async () => {
  for (const dir of await findFixtures(path.join(defaultFixturesRoot(), 'policy'))) {
    const fixture = await fixtureById(path.relative(defaultFixturesRoot(), dir))
    for (const runner of FIXTURE_RUNNERS) {
      if (!fixture.manifest.runners.includes(runner)) continue
      const leaves = subjectLeaves(SUBJECTS[runner])
      for (const [id, value] of observations(await readGolden(fixture.dir, runner))) {
        if (!leaves.has(id)) continue
        assert.deepEqual(json(value), json(leaves.get(id)), `${fixture.id} (${runner}) ${id}`)
      }
    }
  }
})

/** What the scan looks for, in any comment (line, block or JSDoc) and any case. */
const MARKER = /unverified/i

test('no package source says a value is unverified, in any comment or case', async () => {
  const packages = path.join(REPO_ROOT, 'packages')
  const files = await walkFiles(packages, {
    skipDir: (dir) =>
      isNodeModules(dir) ||
      path.posix.basename(dir) === 'vendor' ||
      path.posix.basename(dir).startsWith('.'),
    keep: (file) => file.endsWith('.ts') && file.includes('/src/'),
  })
  // This check names the word twice: its pattern and its title.
  const self = path
    .relative(packages, import.meta.filename)
    .split(path.sep)
    .join('/')
  const found: string[] = []
  for (const file of files) {
    const lines = (await readFile(path.join(packages, file), 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!MARKER.test(line)) continue
      const own = line.includes('const MARKER') || line.includes("test('no package source")
      if (file === self && own) continue
      found.push(`${file}:${index + 1}`)
    }
  }
  assert.deepEqual(found, [])
})
