// What the built package loads for coverage (B23b, T1.10, T7.12): a run with coverage off loads no
// file of the `coverage` chunk in a worker or in the coordinator, and a run with `--coverage` does
// (the control). `exports.test.ts` holds the worker's file count; this holds the chunk's names.
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runBuilt, trackedProjects } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const DIST = `${join(PACKAGE, 'dist')}/`

/** Every file of the `coverage` chunk and the entries only coverage reaches. */
const COVERAGE_FILES = [
  'coverage.js',
  'coverage2.js',
  'coverage-store.js',
  'coverage-reporter.js',
  'instrument.js',
  'initial-coverage.js',
  'reporting.js',
  'runtime.js',
]

const project = trackedProjects()

async function builtProject(): Promise<string> {
  const { dir } = await project({
    'package.json': '{"type":"module","jest":{"testMatch":["**/*.test.js"]}}\n',
    'a.test.js': "test('one', () => { expect(1 + 1).toBe(2) })\n",
    'b.test.js': "test('two', () => { expect(2 + 2).toBe(4) })\n",
  })
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(PACKAGE, join(dir, 'node_modules', 'provino'), 'dir')
  return dir
}

type Load = readonly [main: string, file: string]

/** The `dist/` files each recorded process loaded, with the main module of that process. */
async function distLoads(args: readonly string[]): Promise<readonly Load[]> {
  const dir = await builtProject()
  const logs = await mkdtemp(join(tmpdir(), 'provino-loads-'))
  after(() => rm(logs, { recursive: true, force: true }))
  const run = runBuilt(['jest', '--ci', ...args], {
    cwd: dir,
    preloads: ['load-recorder'],
    env: { PROVINO_LOAD_LOG: logs },
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  const loads: Load[] = []
  for (const log of readdirSync(logs)) {
    for (const line of readFileSync(join(logs, log), 'utf8').split('\n')) {
      const [main = '', url = ''] = line.split('\t')
      if (!url.startsWith('file://')) continue
      const path = fileURLToPath(url)
      if (path.startsWith(DIST)) loads.push([main, path.slice(DIST.length)])
    }
  }
  return loads
}

const covered = (loads: readonly Load[]): readonly Load[] =>
  loads.filter(([, file]) => COVERAGE_FILES.includes(file))

describe('the built package and coverage (T1.10)', () => {
  test('a run without coverage loads no file of the coverage chunk in any process', async () => {
    const loads = await distLoads([])
    assert.ok(
      loads.some(([main]) => main.endsWith('worker/bootstrap.js')),
      'no worker was recorded',
    )
    assert.deepEqual(covered(loads), [])
  })

  test('a run with --coverage loads the chunk in its coordinator and its workers (the control)', async () => {
    const loads = await distLoads(['--coverage', '--coverageReporters=text-summary'])
    const mains = (suffix: string) =>
      covered(loads)
        .filter(([main]) => main.endsWith(suffix))
        .map(([, file]) => file)
    assert.ok(mains('worker/bootstrap.js').includes('coverage.js'), JSON.stringify(covered(loads)))
    assert.ok(mains('cli.js').includes('coverage.js'), JSON.stringify(covered(loads)))
  })
})
