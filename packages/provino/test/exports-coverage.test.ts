// What the built package loads for coverage (B23b, T1.10, T7.12): a run with coverage off loads no
// file of the `coverage` chunk in a worker or in the coordinator, and a run with `--coverage` does
// (the control, which must load every one of them). `exports.test.ts` holds the worker's file count.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'provino'
import { fileURLToPath } from 'node:url'
import { readLoadLogs, runBuilt, trackedProjects, whenFileEnds } from './support.ts'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const DIST = `${join(PACKAGE, 'dist')}/`

/**
 * The coverage files of the build, read from it so the list cannot go stale: the chunk the
 * `coverage` group of `tooling/packaging/src/umbrella.ts` emits (rolldown names a chunk after its
 * group), and every file of `dist/` (workers included) that imports that chunk statically, which
 * is each entry only coverage reaches. A file that a rename or a split leaves out is not claimed.
 */
function coverageFiles(): readonly string[] {
  const umbrella = readFileSync(
    join(PACKAGE, '..', '..', 'tooling', 'packaging', 'src', 'umbrella.ts'),
    'utf8',
  )
  const group = /name: '(coverage)',\s*test: COVERAGE/.exec(umbrella)?.[1]
  assert.ok(group, "umbrella.ts has no `name: 'coverage'` group")
  const chunk = `${group}.js`
  const files = [chunk]
  for (const dir of ['', 'worker/']) {
    for (const name of readdirSync(join(DIST, dir))) {
      if (!name.endsWith('.js') || name === chunk) continue
      const source = readFileSync(join(DIST, dir, name), 'utf8')
      const imports = [...source.matchAll(/^import [^\n]*? from "([^"]+)"/gm)].map((m) => m[1])
      if (imports.includes(`${dir === '' ? './' : '../'}${chunk}`)) files.push(`${dir}${name}`)
    }
  }
  return files
}

const COVERAGE_FILES = coverageFiles()

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
  whenFileEnds(() => rm(logs, { recursive: true, force: true }))
  const run = runBuilt(['jest', '--ci', ...args], {
    cwd: dir,
    preloads: ['load-recorder'],
    env: { PROVINO_LOAD_LOG: logs },
  })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  const loads: Load[] = []
  for (const { main, urls } of readLoadLogs(logs)) {
    for (const url of urls) {
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
  test('the coverage files are found in the build', () => {
    assert.ok(COVERAGE_FILES.length > 1, COVERAGE_FILES.join(', '))
    for (const file of COVERAGE_FILES) assert.ok(existsSync(join(DIST, file)), file)
  })

  test('a run without coverage loads no file of the coverage chunk in any process', async () => {
    const loads = await distLoads([])
    assert.ok(
      loads.some(([main]) => main.endsWith('worker/bootstrap.js')),
      'no worker was recorded',
    )
    assert.deepEqual(covered(loads), [])
  })

  test('a run with --coverage loads every one of them in some process (the control)', async () => {
    const loads = await distLoads(['--coverage', '--coverageReporters=text-summary'])
    const loaded = new Set(covered(loads).map(([, file]) => file))
    assert.deepEqual(
      COVERAGE_FILES.filter((file) => !loaded.has(file)),
      [],
    )
  })
})
