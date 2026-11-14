// T8.10 under the project's own Jest transformer: `provino jest --coverage` on the rebuilt T3.8
// fixture (`packages/transform/fixtures/jest-host`) through the real babel-jest (which instruments
// itself, with babel-plugin-istanbul, as in Jest), ts-jest and @swc/jest (instrumented after them),
// and real Jest 30.5.2 on the same project beside it: each file's summary (statements, branches,
// functions, lines) and the total are equal. Both runs write their reports to a temp directory, so
// the fixture is left as it was.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnCli } from './support.ts'

const FIXTURE: string = fileURLToPath(
  new URL('../../transform/fixtures/jest-host', import.meta.url),
)
const JEST: string = createRequire(join(FIXTURE, 'x.js')).resolve('jest/bin/jest')

const temps: string[] = []
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** The flags both runs get: coverage on, the summary alone, written outside the fixture. */
async function coverageFlags(): Promise<{ readonly dir: string; readonly flags: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-transformers-'))
  temps.push(dir)
  return {
    dir,
    flags: [
      '--coverage',
      '--coverageReporters=json-summary',
      `--coverageDirectory=${dir}`,
      '--no-cache',
      '--ci',
      'greeter',
    ],
  }
}

/** A run's `coverage-summary.json`, its paths relative to the fixture. */
async function summaryOf(dir: string): Promise<unknown> {
  const text = await readFile(join(dir, 'coverage-summary.json'), 'utf8')
  return JSON.parse(text.replaceAll(FIXTURE, '<fixture>'))
}

async function jestSummary(config: string): Promise<unknown> {
  const { dir, flags } = await coverageFlags()
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, '-c', config, ...flags], {
      cwd: FIXTURE,
      stdio: 'ignore',
      env: { ...process.env, NO_COLOR: '1' },
    })
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, 'real Jest passes the fixture with coverage')
  return summaryOf(dir)
}

describe('provino jest --coverage under the project’s own Jest transformer', () => {
  for (const name of ['babel', 'ts-jest', 'swc']) {
    it(`${name}: each file's summary equals real Jest's`, async () => {
      const config = `jest.${name}.config.json`
      const expected = await jestSummary(config)
      // The total and at least the module the test covers.
      assert.ok(Object.keys(expected as object).some((key) => key.endsWith('greeter.ts')))
      const { dir, flags } = await coverageFlags()
      const ran = await spawnCli(['jest', '-c', config, ...flags], {
        cwd: FIXTURE,
        env: { NO_COLOR: '1' },
      })
      assert.equal(ran.code, 0, ran.stderr)
      assert.deepEqual(await summaryOf(dir), expected)
    })
  }
})
