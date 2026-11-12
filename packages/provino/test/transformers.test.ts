// T3.8, end to end: `provino jest` runs the rebuilt fixture (`packages/transform/fixtures/jest-host`:
// a TypeScript test with `jest.mock` below its imports, a factory reading a `mock`-prefixed
// variable and a `__mocks__` file) through the real babel-jest, ts-jest and @swc/jest the project
// names, and each test's status equals the one real Jest 30.5.2 gives the same project, run here
// beside it. The run is from the fixture's directory, as a user's would be: ts-jest finds its
// TypeScript from the working directory.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { viewOfNormalized } from './support.ts'

const FIXTURE: string = fileURLToPath(
  new URL('../../transform/fixtures/jest-host', import.meta.url),
)
const JEST: string = createRequire(join(FIXTURE, 'x.js')).resolve('jest/bin/jest')

const temps: string[] = []
after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-transformers-'))
  temps.push(dir)
  return dir
}

/**
 * `runJestCommand`, loaded by URL: the type-test project includes this directory but not the
 * package's source, and the command has no flag for a reporter yet (T11.9).
 */
const { runJestCommand } = (await import(
  new URL('../src/internal/jest-command.ts', import.meta.url).href
)) as {
  runJestCommand(
    args: readonly string[],
    io: {
      stdout: Writable
      stderr: Writable
      cwd: string
      reporters: readonly (readonly ['normalized-json', { outputFile: string }])[]
    },
  ): Promise<number>
}

class Sink extends Writable {
  text = ''
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString()
    done()
  }
}

/** Each test's status as real Jest reports it, by its full name. */
async function jestRun(
  config: string,
  pattern = 'greeter',
): Promise<{ code: number | null; statuses: ReadonlyMap<string, string> }> {
  const out = join(await temp(), 'jest.json')
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, '-c', config, '--no-cache', '--ci', '--json', `--outputFile=${out}`, pattern],
      { cwd: FIXTURE, stdio: 'ignore' },
    )
    child.once('error', reject)
    child.once('close', resolve)
  })
  const report = JSON.parse(await readFile(out, 'utf8')) as {
    testResults: { assertionResults: { fullName: string; status: string }[] }[]
  }
  const statuses = new Map<string, string>()
  for (const file of report.testResults) {
    for (const test of file.assertionResults) statuses.set(test.fullName, test.status)
  }
  return { code, statuses }
}

/** Each test's status as real Jest reports it, by its full name; the fixture passes under it. */
async function jestStatuses(config: string): Promise<ReadonlyMap<string, string>> {
  const { code, statuses } = await jestRun(config)
  assert.equal(code, 0, 'real Jest passes the fixture')
  return statuses
}

/** Each test's status as Provino reports it, with Jest's word for it. */
async function provinoStatuses(
  config: string,
  cache = false,
  pattern = 'greeter',
): Promise<{ code: number; statuses: ReadonlyMap<string, string>; stderr: string }> {
  const out = join(await temp(), 'run.json')
  const stderr = new Sink()
  const here = process.cwd()
  process.chdir(FIXTURE)
  try {
    const code = await runJestCommand(
      ['-c', config, ...(cache ? [] : ['--no-cache']), '--ci', pattern],
      {
        stdout: new Sink(),
        stderr,
        cwd: FIXTURE,
        reporters: [['normalized-json', { outputFile: out }]],
      },
    )
    const view = viewOfNormalized(await readFile(out, 'utf8'))
    const statuses = new Map<string, string>()
    const jestWord: Readonly<Record<string, string>> = { skipped: 'pending' }
    for (const file of view.files.values()) {
      for (const [path, status] of file.tests) {
        statuses.set(path.replaceAll(' > ', ' '), jestWord[String(status)] ?? String(status))
      }
    }
    return { code, statuses, stderr: stderr.text }
  } finally {
    process.chdir(here)
  }
}

describe('Jest transformers on the rebuilt T3.8 fixture', () => {
  for (const name of ['babel', 'ts-jest', 'swc']) {
    it(`${name}: every test has the status real Jest gives it`, async () => {
      const config = `jest.${name}.config.json`
      const expected = await jestStatuses(config)
      assert.equal(expected.size, 5)
      assert.deepEqual([...expected.values()].sort(), [
        'passed',
        'passed',
        'passed',
        'passed',
        'pending',
      ])
      const ran = await provinoStatuses(config)
      assert.equal(ran.code, 0, ran.stderr)
      assert.deepEqual(
        [...ran.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
        [...expected].sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    })
  }

  for (const name of ['babel', 'ts-jest', 'swc']) {
    it(`${name}: a second run, served from the transform cache, has the same statuses`, async () => {
      const config = `jest.${name}.config.json`
      const expected = await jestStatuses(config)
      const cold = await provinoStatuses(config, true)
      const warm = await provinoStatuses(config, true)
      for (const ran of [cold, warm]) {
        assert.equal(ran.code, 0, ran.stderr)
        assert.deepEqual(
          [...ran.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
          [...expected].sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      }
    })
  }

  for (const name of ['babel', 'ts-jest', 'swc']) {
    it(`${name}: a file importing describe, it, expect and jest from @jest/globals has real Jest's statuses`, async () => {
      const config = `jest.${name}.config.json`
      // Whatever real Jest does with the file, failures included (@swc/jest does not hoist
      // `jest.mock` above an import it takes from `@jest/globals`), Provino does the same.
      const { code, statuses: expected } = await jestRun(config, 'globals')
      assert.equal(expected.size, 2)
      const ran = await provinoStatuses(config, false, 'globals')
      assert.equal(ran.code, code, ran.stderr)
      assert.deepEqual(
        [...ran.statuses].sort(([a], [b]) => (a < b ? -1 : 1)),
        [...expected].sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    })
  }

  it('a project that names a transformer that cannot parse the file fails it, as the transformer says', async () => {
    const ran = await provinoStatuses('jest.broken.config.json').catch((error: unknown) => error)
    // The run wrote no passing result: the file failed to transform.
    assert.ok(
      !(typeof ran === 'object' && ran !== null && 'code' in ran && ran.code === 0),
      'a transformer that rejects the source fails the run',
    )
  })
})
