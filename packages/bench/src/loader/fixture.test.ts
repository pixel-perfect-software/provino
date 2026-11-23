import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, test } from 'provino'
import { FIXTURE_FILES, TESTS_PER_FILE, writeLoaderFixture } from './fixture.ts'
import { createFixtureLoader, runFixture } from './run.ts'

let made: string | undefined
let written: ReturnType<typeof writeLoaderFixture> | undefined
afterAll(() => {
  if (made !== undefined) rmSync(made, { recursive: true, force: true })
})

/** The fixture on disk, written by the first test that needs it (importing the file writes none). */
function fixture(): { dir: string; files: ReturnType<typeof writeLoaderFixture> } {
  made ??= realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-fixture-test-')))
  written ??= writeLoaderFixture(made, { heavy: false })
  return { dir: made, files: written }
}

function countModules(path: string): number {
  let count = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countModules(join(path, entry.name))
    else if (entry.name.endsWith('.ts')) count++
  }
  return count
}

test('the fixture has Spike A’s shape: 200 test files over 641 user modules', () => {
  const { dir, files } = fixture()
  assert.equal(files.length, FIXTURE_FILES)
  const userModules =
    countModules(join(dir, 'core')) + countModules(join(dir, 'features')) + 1 /* state.ts */
  assert.equal(userModules, 641)
})

test('registry: every test passes with no isolation violation (B06 acceptance)', async () => {
  const { dir, files } = fixture()
  const result = await runFixture(createFixtureLoader(dir), files, 'registry')
  assert.deepEqual(result.failures, [])
  assert.equal(result.passed, FIXTURE_FILES * TESTS_PER_FILE)
  assert.equal(result.violations, 0)
})

test('none: the same check reports violations, so it can fail', async () => {
  const { dir, files } = fixture()
  const result = await runFixture(createFixtureLoader(dir), files, 'none')
  assert.ok(result.violations > 0)
})
