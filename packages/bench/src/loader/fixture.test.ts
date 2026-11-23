import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'provino'
import { FIXTURE_FILES, TESTS_PER_FILE, writeLoaderFixture } from './fixture.ts'
import { createFixtureLoader, runFixture } from './run.ts'

// Written in `beforeAll`, which a listing of the file (every test skipped) never runs.
let dir: string
let files: ReturnType<typeof writeLoaderFixture>
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-fixture-test-')))
  files = writeLoaderFixture(dir, { heavy: false })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function countModules(path: string): number {
  let count = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countModules(join(path, entry.name))
    else if (entry.name.endsWith('.ts')) count++
  }
  return count
}

test('the fixture has Spike A’s shape: 200 test files over 641 user modules', () => {
  assert.equal(files.length, FIXTURE_FILES)
  const userModules =
    countModules(join(dir, 'core')) + countModules(join(dir, 'features')) + 1 /* state.ts */
  assert.equal(userModules, 641)
})

test('registry: every test passes with no isolation violation (B06 acceptance)', async () => {
  const result = await runFixture(createFixtureLoader(dir), files, 'registry')
  assert.deepEqual(result.failures, [])
  assert.equal(result.passed, FIXTURE_FILES * TESTS_PER_FILE)
  assert.equal(result.violations, 0)
})

test('none: the same check reports violations, so it can fail', async () => {
  const result = await runFixture(createFixtureLoader(dir), files, 'none')
  assert.ok(result.violations > 0)
})
