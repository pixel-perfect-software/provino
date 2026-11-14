import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from './errors.ts'
import { parseFixtureManifest } from './fixture.ts'

function rejects(code: HarnessErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof HarnessError && error.code === code
}

const VALID = {
  description: 'what it shows',
  runners: ['jest'],
  scm: { steps: [{ commit: 'base' }] },
}
const WATCH = {
  argv: ['--watch'],
  tty: true,
  steps: [{ waitRun: 1 }, { key: 'q' }, { exit: 0 }],
  capture: ['runs', 'transcript', 'exitCode'],
}

function parse(watch: unknown, extra: Record<string, unknown> = {}) {
  return parseFixtureManifest(JSON.stringify({ ...VALID, ...extra, watch }))
}

function bad(watch: unknown, extra: Record<string, unknown> = {}): void {
  assert.throws(() => parse(watch, extra), rejects('HARNESS_FIXTURE_BAD_WATCH'))
}

test('watch keeps its argv, steps, captures, keepLines and mask, with write paths normalized', () => {
  const watch = {
    argv: ['--watchAll', '--verbose=false'],
    tty: true,
    steps: [
      { waitRun: 1 },
      { key: 'p' },
      { waitText: 'Pattern Mode Usage' },
      { type: 'foo' },
      { key: '<enter>' },
      { waitRun: 2 },
      { write: { './src/a.ts': 'x' } },
      { remove: ['src/b.ts'] },
      { scm: [{ commit: 'more' }] },
      { waitRun: 3 },
      { key: '<ctrl-c>' },
      { exit: 0 },
    ],
    capture: ['runs', 'transcript', 'exitCode', 'file:__snapshots__/a.test.ts.snap'],
    keepLines: '^Watch Usage',
    mask: ['pid \\d+'],
  }
  assert.deepEqual(parse(watch).watch, {
    ...watch,
    steps: watch.steps.map((step) => ('write' in step ? { write: { 'src/a.ts': 'x' } } : step)),
  })
})

test('a session that ends by being killed captures no exit code and needs no exit step', () => {
  const watch = {
    argv: ['--watch'],
    tty: false,
    steps: [{ waitRun: 1 }, { write: { 'a.ts': 'y' } }, { waitRun: 2 }],
    capture: ['runs', 'transcript'],
  }
  assert.deepEqual(parse(watch).watch, watch)
  bad({ ...watch, capture: ['runs', 'exitCode'] })
})

test('watch is Jest-only, and never beside run, before or a reporters overlay', () => {
  bad(WATCH, { runners: ['jest', 'vitest'] })
  bad(WATCH, { runners: ['vitest'] })
  bad(WATCH, { run: { capture: ['stdout'] } })
  bad(WATCH, { before: [{ argv: [] }] })
  bad(WATCH, { config: { jest: { reporters: ['default'] } } })
  // Other options are the fixture's: a watch plugin, a path to ignore.
  assert.ok(parse(WATCH, { config: { jest: { watchPlugins: ['./plugin.js'] } } }).watch)
})

test('watch.argv holds --watch or --watchAll once, no option the recorder owns, and never --ci', () => {
  bad({ ...WATCH, argv: [] })
  bad({ ...WATCH, argv: ['--watch', '--watchAll'] })
  bad({ ...WATCH, argv: ['--watch', '--watch'] })
  bad({ ...WATCH, argv: ['--watch=true'] })
  bad({ ...WATCH, argv: ['--watch', 3] })
  for (const owned of ['--json', '--outputFile=x', '--config=x', '-c', '--reporters=default']) {
    bad({ ...WATCH, argv: ['--watch', owned] })
  }
  for (const ci of ['--ci', '--ci=false', '--no-ci', '--ci=true']) {
    assert.throws(
      () => parse({ ...WATCH, argv: ['--watch', ci] }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === 'HARNESS_FIXTURE_BAD_WATCH' &&
        error.message.includes('never a CI run'),
    )
  }
})

test('watch refuses unknown fields, a bad tty and empty steps', () => {
  bad({ ...WATCH, timeout: 5 })
  bad({ ...WATCH, tty: 'yes' })
  bad({ argv: WATCH.argv, steps: WATCH.steps, capture: WATCH.capture })
  bad({ ...WATCH, steps: [] })
  bad({ ...WATCH, steps: 'waitRun' })
  bad('watch')
})

test('a step has exactly one known key and a value of its kind', () => {
  const withStep = (step: unknown): void =>
    bad({ ...WATCH, steps: [step, { exit: 0 }], capture: ['runs'] })
  withStep({})
  withStep({ waitRun: 1, key: 'q' })
  withStep({ sleep: 100 })
  withStep({ waitRun: 0 })
  withStep({ waitRun: 1.5 })
  withStep({ waitRun: '1' })
  withStep({ waitText: '' })
  withStep({ type: '' })
  withStep({ key: '' })
  withStep({ key: 'ab' })
  withStep({ key: '<f1>' })
  withStep({ key: '\u0007' })
  withStep({ exit: -1 })
  withStep({ exit: 256 })
  withStep(null)
  // A write outside the work directory is the scm parser's refusal.
  assert.throws(
    () => parse({ ...WATCH, steps: [{ write: { '../x': '' } }, { exit: 0 }], capture: ['runs'] }),
    rejects('HARNESS_FIXTURE_BAD_SCM'),
  )
  assert.throws(
    () => parse({ ...WATCH, steps: [{ scm: [{ push: 'x' }] }, { exit: 0 }], capture: ['runs'] }),
    rejects('HARNESS_FIXTURE_BAD_SCM'),
  )
})

test('every named key and any printable character is a key', () => {
  for (const key of ['<enter>', '<esc>', '<backspace>', '<up>', '<down>', '<ctrl-c>', '<ctrl-d>']) {
    assert.ok(parse({ ...WATCH, steps: [{ key }, { exit: 0 }] }).watch)
  }
  for (const key of ['a', 'Q', '?', ' ', '9', '›']) {
    assert.ok(parse({ ...WATCH, steps: [{ key }, { exit: 0 }] }).watch)
  }
})

test('steps are ordered so a recording is deterministic', () => {
  // Two keys in a row could reach Jest in one read, as one keypress.
  bad({ ...WATCH, steps: [{ key: 'p' }, { key: 'q' }, { exit: 0 }] })
  bad({ ...WATCH, steps: [{ key: 'p' }, { type: 'foo' }, { exit: 0 }] })
  assert.ok(
    parse({ ...WATCH, steps: [{ type: 'foo' }, { key: '<enter>' }, { waitRun: 1 }, { exit: 0 }] })
      .watch,
  )
  // Runs only count up.
  bad({ ...WATCH, steps: [{ waitRun: 2 }, { waitRun: 1 }, { exit: 0 }] })
  // `exit` ends the steps.
  bad({ ...WATCH, steps: [{ exit: 0 }, { waitRun: 1 }] })
  bad({ ...WATCH, steps: [{ exit: 0 }, { exit: 0 }] })
})

test('a session on a pipe types nothing, and an scm step needs the fixture repository', () => {
  bad({ ...WATCH, tty: false, steps: [{ key: 'q' }, { exit: 0 }] })
  bad({ ...WATCH, tty: false, steps: [{ type: 'q' }, { exit: 0 }] })
  const scmStep = { ...WATCH, steps: [{ scm: [{ commit: 'x' }] }, { exit: 0 }] }
  assert.ok(parse(scmStep).watch)
  assert.throws(
    () =>
      parseFixtureManifest(JSON.stringify({ description: 'x', runners: ['jest'], watch: scmStep })),
    rejects('HARNESS_FIXTURE_BAD_WATCH'),
  )
})

test('capture names runs, transcript, exitCode and files inside the fixture, each once', () => {
  bad({ ...WATCH, capture: [] })
  bad({ ...WATCH, capture: ['stdout'] })
  bad({ ...WATCH, capture: ['runs', 'runs'] })
  bad({ ...WATCH, capture: ['file:../out'] })
  bad({ ...WATCH, capture: ['json:a.json'] })
  bad({ ...WATCH, capture: 'runs' })
  // keepLines cuts the transcript, so it needs one; both it and mask must be regular expressions.
  bad({ ...WATCH, capture: ['runs'], keepLines: 'x' })
  bad({ ...WATCH, keepLines: '(' })
  bad({ ...WATCH, keepLines: '' })
  bad({ ...WATCH, mask: [] })
  bad({ ...WATCH, mask: ['('] })
  bad({ ...WATCH, mask: [''] })
})
