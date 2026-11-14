import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HarnessError, type HarnessErrorCode } from './errors.ts'
import { parseFixtureManifest, parseScmSteps } from './fixture.ts'

function rejects(code: HarnessErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof HarnessError && error.code === code
}

const VALID = { description: 'what it shows', runners: ['jest'] }

test('scm keeps its steps, with write paths normalized', () => {
  const steps = [
    { commit: 'base' },
    { branch: 'feature' },
    { write: { './a.txt': 'x' } },
    { git: ['add', 'a.txt'] },
    { remove: ['a.txt'] },
    { checkout: 'main' },
  ]
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, scm: { steps } })).scm, {
    steps: [
      { commit: 'base' },
      { branch: 'feature' },
      { write: { 'a.txt': 'x' } },
      { git: ['add', 'a.txt'] },
      { remove: ['a.txt'] },
      { checkout: 'main' },
    ],
  })
  // No steps is a repository with nothing committed.
  assert.deepEqual(parseFixtureManifest(JSON.stringify({ ...VALID, scm: { steps: [] } })).scm, {
    steps: [],
  })
})

test('scm refuses a bad shape, a step that is not one known key and a path in .git', () => {
  const bad = (scm: unknown): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, scm })),
      rejects('HARNESS_FIXTURE_BAD_SCM'),
    )
  bad([])
  bad({})
  bad({ steps: 'commit' })
  bad({ steps: [], extra: 1 })
  bad({ steps: ['commit'] })
  bad({ steps: [{}] })
  bad({ steps: [{ commit: 'a', branch: 'b' }] })
  bad({ steps: [{ amend: true }] })
  bad({ steps: [{ commit: '' }] })
  bad({ steps: [{ branch: '-x' }] })
  bad({ steps: [{ checkout: '' }] })
  bad({ steps: [{ git: [] }] })
  bad({ steps: [{ git: ['add', 1] }] })
  // The hermetic settings are the recorder's: a step may not replace them.
  bad({ steps: [{ git: ['-c', 'commit.gpgsign=true', 'commit'] }] })
  bad({ steps: [{ git: ['--git-dir=/x', 'status'] }] })
  bad({ steps: [{ write: {} }] })
  bad({ steps: [{ write: { '../a': 'x' } }] })
  bad({ steps: [{ write: { '.git/config': 'x' } }] })
  bad({ steps: [{ write: { 'a.txt': 1 } }] })
  bad({ steps: [{ remove: [] }] })
  bad({ steps: [{ remove: ['/etc/passwd'] }] })
  bad({ steps: [{ remove: ['.git'] }] })
})

test('parseScmSteps takes any list of steps and names the field in its errors', () => {
  assert.deepEqual(parseScmSteps([{ commit: 'm' }], 'fixture.json', 'watch.steps[0].scm'), [
    { commit: 'm' },
  ])
  assert.throws(
    () => parseScmSteps([{ commit: 1 }], 'fixture.json', 'watch.steps[0].scm'),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_FIXTURE_BAD_SCM' &&
      error.message.includes('"watch.steps[0].scm"'),
  )
})

test('before is a list of runs with their own arguments, for Jest only', () => {
  assert.deepEqual(
    parseFixtureManifest(JSON.stringify({ ...VALID, before: [{ argv: ['-u'] }, { argv: [] }] }))
      .before,
    [{ argv: ['-u'] }, { argv: [] }],
  )
  const bad = (before: unknown, runners: string[] = ['jest']): void =>
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, runners, before })),
      rejects('HARNESS_FIXTURE_BAD_BEFORE'),
    )
  bad([])
  bad({ argv: [] })
  bad([{}])
  bad([{ argv: 'x' }])
  bad([{ argv: [1] }])
  bad([{ argv: [], extra: true }])
  bad([{ argv: [] }], ['jest', 'vitest'])
  bad([{ argv: [] }], ['vitest'])
})

test('before arguments go through the same reserved-flag check as run.argv', () => {
  for (const arg of ['--config=x', '--json', '--outputFile', '--rootDir=/', '--no-output-file']) {
    assert.throws(
      () => parseFixtureManifest(JSON.stringify({ ...VALID, before: [{ argv: [arg] }] })),
      rejects('HARNESS_FIXTURE_BAD_BEFORE'),
      arg,
    )
  }
})

test('an unknown manifest key still names scm and before among the known ones', () => {
  assert.throws(
    () => parseFixtureManifest(JSON.stringify({ ...VALID, nope: 1 })),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === 'HARNESS_FIXTURE_UNKNOWN_KEY' &&
      error.message.includes('scm, before'),
  )
})
