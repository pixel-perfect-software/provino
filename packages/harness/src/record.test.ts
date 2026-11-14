import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from './errors.ts'
import { recordFixture } from './record.ts'

/** A one-test Jest fixture whose `run` is exact: the recorder adds nothing to its argv. */
async function makeExactFixture(root: string, argv: readonly string[]): Promise<string> {
  const dir = path.join(root, 'exact-argv')
  await mkdir(dir)
  await writeFile(
    path.join(dir, 'fixture.json'),
    JSON.stringify({
      description: 'an exact run',
      runners: ['jest'],
      env: { SHOW: 'seen', NO_COLOR: null },
      run: {
        exact: true,
        argv: { jest: argv },
        capture: ['exitCode', 'json:mine.json', 'file:.harness-out/jest.json'],
        timeKeys: ['startTime', 'endTime', 'duration'],
      },
    }),
  )
  await writeFile(
    path.join(dir, 'a.test.ts'),
    "it('runs', () => { expect(process.env.NO_COLOR).toBeUndefined() })\n",
  )
  return dir
}

test("an exact run gives Jest the fixture's argv and nothing of the recorder's own", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'exact-record-')))
  try {
    const dir = await makeExactFixture(root, ['--ci=false', '--json', '--outputFile=mine.json'])
    const result = await recordFixture(dir, 'jest')
    assert.equal(result.outcome, 'written')
    const golden: unknown = JSON.parse(
      await readFile(path.join(dir, '__goldens__', 'jest.json'), 'utf8'),
    )
    const text = JSON.stringify(golden)
    // Jest found the recorder's config from the work directory (it ran the test, which saw
    // `NO_COLOR` removed) and wrote the file the fixture's own argv named...
    assert.match(text, /"numPassedTests": ?1/)
    // ...and the recorder's `--json --outputFile=.harness-out/jest.json` was never passed.
    assert.match(text, /"\.harness-out\/jest\.json": ?null/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an exact run refuses a Jest config the fixture brings in its directory', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'exact-record-')))
  try {
    for (const [name, text] of [
      ['jest.config.json', '{}'],
      ['package.json', '{ "jest": {} }'],
    ] as const) {
      const dir = await makeExactFixture(root, ['--ci=false'])
      await writeFile(path.join(dir, name), text)
      await assert.rejects(
        recordFixture(dir, 'jest'),
        (error: unknown) =>
          error instanceof HarnessError &&
          error.code === 'HARNESS_FIXTURE_BAD_RUN' &&
          error.message.includes(name),
      )
      await rm(dir, { recursive: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
