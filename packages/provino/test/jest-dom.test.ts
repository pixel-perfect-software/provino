// B17c end to end: a project on `jest-environment-jsdom`, with a mapper and two docblocks, read by
// the Jest config reader and run through `provino jest` (D44: the project's own environment
// package, run through the adapter). Held to the verdicts real Jest 30.5.2 recorded for the same
// trees (`env/*`), test by test: each test's status is the recorded one (a declared divergence
// aside), and real Jest run live on the same temp tree gives the same statuses again.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIXTURES, loadFixture, materialize } from './recorded.ts'
import { spawnCli, viewOfNormalized } from './support.ts'

const JEST: string = createRequire(
  fileURLToPath(new URL('../../harness/package.json', import.meta.url)),
).resolve('jest/bin/jest')

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

/** The harness's transformer, which strips types for real Jest as the recorder does. */
const TRANSFORMER = fileURLToPath(new URL('../../harness/src/jest-transform.ts', import.meta.url))

function runJest(cwd: string, out: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [JEST, '--no-cache', '--ci', '-c', 'jest.live.json', '--json', `--outputFile=${out}`],
      { cwd, stdio: 'ignore' },
    )
    child.once('error', reject)
    child.once('close', resolve)
  })
}

type Statuses = ReadonlyMap<string, string>

/** Real Jest's live statuses by `<file>::<full name>`. */
async function liveJest(cwd: string): Promise<Statuses> {
  const out = join(cwd, '.out-jest.json')
  const config = JSON.parse(await readFile(join(cwd, 'jest.config.json'), 'utf8')) as object
  await writeFile(
    join(cwd, 'jest.live.json'),
    JSON.stringify({ ...config, transform: { '\\.[cm]?ts$': TRANSFORMER } }),
  )
  await runJest(cwd, out)
  const report = JSON.parse(await readFile(out, 'utf8')) as {
    testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
  }
  const map = new Map<string, string>()
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      map.set(`${relative(cwd, file.name)}::${test.fullName}`, test.status)
    }
  }
  return map
}

/** Provino's statuses, read from its normalized-json, in Jest's words. */
async function provinoRun(
  cwd: string,
): Promise<{ code: number; statuses: Statuses; stderr: string }> {
  const out = join(cwd, '.out-provino.json')
  const stderr = new Sink()
  const code = await runJestCommand(['--no-cache', '--ci', '-c', 'jest.config.json'], {
    stdout: new Sink(),
    stderr,
    cwd,
    reporters: [['normalized-json', { outputFile: out }]],
  })
  const word: Readonly<Record<string, string>> = { skipped: 'pending' }
  const map = new Map<string, string>()
  for (const [file, entry] of viewOfNormalized(await readFile(out, 'utf8')).files) {
    const path = file.startsWith('/') ? relative(cwd, file) : file
    for (const [name, status] of entry.tests) {
      map.set(`${path}::${name.replaceAll(' > ', ' ')}`, word[String(status)] ?? String(status))
    }
  }
  return { code, statuses: map, stderr: stderr.text }
}

const sorted = (map: Statuses): [string, string][] => [...map].sort(([a], [b]) => (a < b ? -1 : 1))

/** The real directory of a package the harness installs (the project's own copy, as pnpm links it). */
function packageDir(name: string): string {
  const require = createRequire(join(FIXTURES, 'x.js'))
  return dirname(require.resolve(`${name}/package.json`))
}

/**
 * Tests Jest passes and Provino fails today, declared (proposed DIVERGENCE, Track 8 R5): under the
 * `registry` tier test code runs in the worker's realm, and a jsdom node's prototype chain ends in
 * the window's own `Object.prototype`, not the worker's. T2.8 (the realm tier) is the fix.
 */
const DECLARED: Readonly<Record<string, readonly string[]>> = {
  'env/realm-instanceof': ['a div is an instance of Object'],
}

const PROJECTS = [
  ['env/realm-instanceof', 'the realm checks (Track 8 R5)'],
  ['env/jsdom-project', 'every file passes, with its docblocks and mapper'],
  ['env/conditions-jsdom', "jsdom's `browser` export condition (T8.7)"],
  ['env/conditions-custom', '`customExportConditions: [""]` drops `browser` (T8.7)'],
  ['env/conditions-node', "the node environment's `node` condition (T8.7)"],
] as const

describe('a Jest project on its own environment, against Jest 30.5.2', () => {
  for (const [id, title] of PROJECTS) {
    it(`${id}: ${title}`, async () => {
      const fixture = await loadFixture(id)
      const project = await materialize(fixture)
      try {
        await mkdir(join(project.root, 'node_modules'), { recursive: true })
        for (const name of ['jest-environment-jsdom', 'jest-environment-node']) {
          await symlink(packageDir(name), join(project.root, 'node_modules', name))
        }
        const recorded = new Map<string, string>()
        for (const file of fixture.golden.files) {
          for (const test of file.tests ?? []) {
            recorded.set(`${file.file}::${test.id.path.join(' ')}`, test.status)
          }
        }
        // What Provino should give: the recorded status, but a declared divergence fails.
        const expected = new Map(recorded)
        for (const [key] of expected) {
          if ((DECLARED[id] ?? []).some((name) => key.endsWith(`::${name}`))) {
            expected.set(key, 'failed')
          }
        }
        assert.ok(recorded.size > 0)
        assert.deepEqual(sorted(await liveJest(project.root)), sorted(recorded))
        const ended = await provinoRun(project.root)
        assert.deepEqual(sorted(ended.statuses), sorted(expected), ended.stderr)
        const failing = [...expected.values()].some((status) => status !== 'passed')
        assert.equal(ended.code, failing ? 1 : 0, ended.stderr)
        const cli = await spawnCli(['jest', '--ci', '-c', 'jest.config.json'], {
          cwd: project.root,
        })
        assert.equal(cli.code, ended.code, cli.stderr)
        assert.doesNotMatch(cli.stderr, /not applied/)
      } finally {
        await project.dispose()
      }
    })
  }
})
