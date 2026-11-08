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
import { describe, test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import {
  defaultFixturesRoot,
  FIXTURE_RUNNERS,
  type FixtureRunner,
  findFixtures,
} from '../fixture.ts'
import { readGolden } from '../golden.ts'
import { isNodeModules, walkFiles } from '../internal/walk.ts'
import { CLAIMS } from './claims/index.ts'
import { corpusProblems, fixtureById } from './corpora.ts'
import { type Evidence, evidenceFor } from './evidence.ts'
import { DOMAINS, flipsOf } from './flip.ts'
import { coveringKey, withLeaf } from './leaves.ts'
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
  'jest core.doneDeprecatedMessage': 'B17a',
  'jest core.formatEachTitle': 'B17a',
  'jest timers.fakeTemporal': 'B17a',
  'jest snapshot.inline.formatter': 'B17b',
  'jest snapshot.inline.indent': 'B17b',
  'jest orchestrator.environmentConditions': 'B17c',
  'jest hoist.messages.HOIST_FACTORY_NOT_FUNCTION': 'B13c',
  'jest hoist.messages.HOIST_FACTORY_OUT_OF_SCOPE': 'B13c',
  'jest module.messages.automock-no-metadata': 'B13c',
  'jest orchestrator.sequence.unknownFirst': 'B21',
  'jest orchestrator.shard.fallback': 'B21',
  'jest orchestrator.watch.initialRun': 'T9.11',
  'jest report.resultStatusSkipped': 'T11.8',
  'jest coverage.globThresholdScope': 'T8.9',
  'jest coverage.includeUntestedByDefault': 'T8.9',
  'jest coverage.thresholdGrouping': 'T8.9',
  'jest lazy.readInBeforeAll': 'T6.5',
  'vitest core.doneDeprecatedMessage': 'B17a',
  'vitest core.formatEachTitle': 'B17a',
  'vitest timers.fakeTemporal': 'B17a',
  'vitest snapshot.format.maxOutputLength': 'B17b',
  'vitest snapshot.inline.formatter': 'B17b',
  'vitest snapshot.inline.indent': 'B17b',
  'vitest orchestrator.environmentConditions': 'B17c',
  'vitest hoist.messages.HOIST_EXPORTED': 'B13c',
  'vitest hoist.messages.HOIST_EXPORTED_VALUE': 'B13c',
  'vitest hoist.messages.HOIST_NESTED': 'B13c',
  'vitest hoist.messages.HOIST_NOT_TOP_LEVEL': 'B13c',
  'vitest mock.messages.spy-namespace': 'B13c',
  'vitest orchestrator.sequence.unknownFirst': 'B21',
  'vitest orchestrator.shard.fallback': 'B21',
  'vitest orchestrator.watch.initialRun': 'T9.11',
  'vitest report.resultStatusSkipped': 'T11.8',
  'vitest coverage.globThresholdScope': 'T8.9',
  'vitest coverage.includeUntestedByDefault': 'T8.9',
  'vitest coverage.thresholdGrouping': 'T8.9',
  'vitest expect.matcherTable': 'T7.6',
  'vitest lazy.readInBeforeAll': 'T6.5',
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

/** The problems of a corpus run under the dialect's own policy, once per fixture. */
const baselines = new Map<string, Promise<string>>()
function baseline(
  corpus: 'runtime' | 'mock' | 'mod',
  fixture: string,
  subject: DialectSubject,
): Promise<string> {
  const key = `${corpus} ${fixture} ${subject.runner}`
  let found = baselines.get(key)
  if (found === undefined) {
    found = corpusProblems(corpus, fixture, { profile: subject.runner, ...subject }).then((p) =>
      JSON.stringify(p),
    )
    baselines.set(key, found)
  }
  return found
}

/** The subject with one leaf flipped. */
function flipped(subject: DialectSubject, leaf: string, value: unknown): DialectSubject {
  if (leaf.startsWith('hoist.')) {
    return { ...subject, hoist: withLeaf(subject.hoist, leaf.slice('hoist.'.length), value) }
  }
  return { ...subject, policy: withLeaf(subject.policy, leaf, value) }
}

/**
 * Checks one piece of evidence for one leaf, and returns the indexes of the flips it rejects.
 * Own and inert evidence rejects every flip by definition: nothing to observe.
 */
async function check(
  evidence: Evidence,
  leaf: string,
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
        // The hoist corpus flips each key itself, against the real hoisters.
        const source = await readFile(
          path.join(import.meta.dirname, '..', 'hoist-corpus.test.ts'),
          'utf8',
        )
        const key = leaf.slice('hoist.'.length).split('.')[0]
        assert.ok(source.includes(`key: '${key}'`), `hoist-corpus.test.ts has no flip of ${key}`)
        return all
      }
      const corpus = evidence.corpus
      assert.ok(evidence.fixtures.length > 0, 'a corpus claim names its fixtures')
      const rejected = new Set<number>()
      for (const fixture of evidence.fixtures) {
        // A fixture recorded for the other runner only says nothing about this one.
        if (!(await fixtureById(fixture)).manifest.runners.includes(subject.runner)) continue
        const before = await baseline(corpus, fixture, subject)
        for (const [index, flip] of flips.entries()) {
          if (rejected.has(index)) continue
          const after = JSON.stringify(
            await corpusProblems(corpus, fixture, {
              profile: subject.runner,
              ...flipped(subject, leaf, flip),
            }),
          )
          if (after !== before) rejected.add(index)
        }
      }
      // A group claim's corpus may catch flips of only some of its leaves; the test's last check
      // is that some evidence rejects every flip.
      return rejected
    }
    case 'own': {
      const text = await readFile(path.join(REPO_ROOT, evidence.test), 'utf8')
      assert.ok(
        text.includes(evidence.mentions),
        `${evidence.test} doesn't mention ${evidence.mentions}`,
      )
      return all
    }
    case 'inert': {
      assert.ok(leaves.has(evidence.under), `${evidence.under} is not a leaf`)
      assert.deepEqual(
        json(leaves.get(evidence.under)),
        json(evidence.when),
        `${evidence.under}'s value`,
      )
      const backing = evidenceOf(evidence.under, subject.runner)
      assert.ok(
        backing.some((other) => other.kind !== 'inert' && other.kind !== 'pending'),
        `${evidence.under} has evidence of its own`,
      )
      return all
    }
    case 'pending':
      return new Set()
  }
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
        const rejected = new Set<number>()
        for (const piece of evidence) {
          for (const index of await check(piece, leaf, value, flips, subject, leaves)) {
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

test('no package source says a value is unverified', async () => {
  const packages = path.join(REPO_ROOT, 'packages')
  const files = await walkFiles(packages, {
    skipDir: (dir) => isNodeModules(dir) || path.posix.basename(dir) === 'vendor',
    keep: (file) => file.endsWith('.ts') && file.includes('/src/'),
  })
  const found: string[] = []
  for (const file of files) {
    const lines = (await readFile(path.join(packages, file), 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      if (/\/\/\s*unverified\b/.test(line)) found.push(`${file}:${index + 1}`)
    }
  }
  assert.deepEqual(found, [])
})
