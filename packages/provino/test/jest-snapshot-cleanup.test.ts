// B23d B1 review fixes: the cleanup of snapshot files no test file has, and `snapshotResolver`,
// held to real Jest 30.5.2 on the same tree. Each case builds one tree twice (Jest deletes under
// `-u`), runs live Jest on one copy and `provino jest` on the other, under one environment
// (`outputFree`, which `spawnCli` gives Provino: CI sets `CI`, and Jest reads it), and compares the
// exit code, the `.snap` files left and the Snapshot Summary lines. Nothing here is a recording:
// what Jest does is read off the live run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, describe, it } from 'node:test'
import { JEST } from './live-jest.ts'
import { outputFree, spawnCli } from './support.ts'

const made: string[] = []
after(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })))
})

type Files = Readonly<Record<string, string>>

async function tree(files: Files): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'provino-cleanup-')))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }
  return dir
}

const SNAP =
  '// Jest Snapshot v1, https://jestjs.io/docs/snapshot-testing\n\nexports[`x 1`] = `1`;\n'
const PASS = "test('t', () => { expect(1).toBe(1) })\n"

/** Every file under `dir` whose name ends in `.snap`, relative and sorted, `node_modules` included. */
async function snapFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.snap')) found.push(relative(dir, full))
    }
  }
  await walk(dir)
  return found.sort()
}

interface Ended {
  readonly code: number | null
  readonly stderr: string
  readonly left: string[]
}

/** Real Jest on `dir`, with the watchman crawl off (the haste map's own crawl is what is compared). */
async function jest(dir: string, args: readonly string[]): Promise<Ended> {
  const ended = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [JEST, '--no-watchman', ...args], {
      cwd: dir,
      env: outputFree(),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stderr }))
  })
  return { ...ended, left: await snapFiles(dir) }
}

async function provino(dir: string, args: readonly string[]): Promise<Ended> {
  const ended = await spawnCli(['jest', ...args], { cwd: dir })
  assert.equal(ended.signal, null, 'it exited, it was not killed')
  return { code: ended.code, stderr: ended.stderr, left: await snapFiles(dir) }
}

/**
 * The lines of the Snapshot Summary and the totals that speak of snapshot files, the listed files
 * last and sorted: across several projects Jest lists them in its sequencer's order of the
 * projects, Provino in the config's (an open item, not what these cases are about).
 */
function snapshotLines(stderr: string): string[] {
  const lines = stderr
    .split('\n')
    .filter((line) => /snapshot files? (?:removed|obsolete)|•|^Snapshots:/.test(line))
    .map((line) => line.trimEnd())
  const listed = lines.filter((line) => line.includes('•')).map((line) => line.replace(/^.*• /, ''))
  return [...lines.filter((line) => !line.includes('•')), ...listed.sort()]
}

/** Jest and Provino on two copies of one tree: the same exit code, files left and summary lines. */
async function sameAsJest(
  files: Files,
  args: readonly string[],
): Promise<{ jest: Ended; provino: Ended }> {
  const [one, two] = [await tree(files), await tree(files)]
  const expected = await jest(one, args)
  const got = await provino(two, args)
  assert.equal(got.code, expected.code, got.stderr)
  assert.deepEqual(got.left, expected.left, '.snap files left')
  assert.deepEqual(snapshotLines(got.stderr), snapshotLines(expected.stderr), 'snapshot summary')
  return { jest: expected, provino: got }
}

const project = (name: string, extra: Record<string, unknown> = {}): Files => ({
  [`${name}/jest.config.json`]: JSON.stringify({
    displayName: name,
    testMatch: ['<rootDir>/**/*.test.js'],
    ...extra,
  }),
  [`${name}/${name}.test.js`]: PASS,
  [`${name}/__snapshots__/gone.test.js.snap`]: SNAP,
})

const BASE: Files = { 'package.json': '{"type":"commonjs"}\n' }
const CI_OFF = ['--no-cache', '--ci=false']

describe('the cleanup visits the projects that ran a test file, as Jest does', () => {
  const projects: Files = {
    ...BASE,
    'jest.config.json': JSON.stringify({ projects: ['<rootDir>/a', '<rootDir>/b'] }),
    ...project('a'),
    ...project('b'),
  }

  it('-u with a path filter that selects one project leaves the other project’s orphan alone', async () => {
    const { jest: expected } = await sameAsJest(projects, [...CI_OFF, '-u', 'a/a.test'])
    assert.deepEqual(expected.left, ['b/__snapshots__/gone.test.js.snap'], 'Jest cleaned only a')
  })

  it('with no filter both projects are cleaned', async () => {
    const { jest: expected } = await sameAsJest(projects, [...CI_OFF, '-u'])
    assert.deepEqual(expected.left, [])
  })

  it('without -u the filtered run reports only the selected project’s orphan', async () => {
    const { jest: expected } = await sameAsJest(projects, [...CI_OFF, 'a/a.test'])
    assert.equal(expected.left.length, 2)
    assert.ok(snapshotLines(expected.stderr).some((line) => line.includes('a/__snapshots__')))
  })
})

// A resolver that builds in a worker and not in the scheduler's own process: a forked worker has
// `process.send`, the process that schedules the run has none. Jest builds every project's
// resolver again after the run (`updateSnapshotState`), so the failure ends the run there.
const COORDINATOR_ONLY_FAILURE = "resolver can't be built outside a worker"
const RESOLVER = `const path = require('node:path')
if (process.send === undefined) throw new Error(${JSON.stringify(COORDINATOR_ONLY_FAILURE)})
module.exports = {
  resolveSnapshotPath: (testPath, ext) =>
    path.join(path.dirname(testPath), '__snaps__', path.basename(testPath) + ext),
  resolveTestPath: (snapPath, ext) =>
    path.join(path.dirname(snapPath), '..', path.basename(snapPath, ext)),
  testPathForConsistencyCheck: path.join('some', 'dir', 'foo.test.js'),
}
`

describe('a snapshotResolver that cannot be built after the run ends the run, as in Jest', () => {
  const WORKERS = [...CI_OFF, '-w', '2']

  it('the tests pass, the error is printed, and the exit code is 1', async () => {
    const files = {
      ...BASE,
      'jest.config.json': JSON.stringify({ snapshotResolver: '<rootDir>/resolver.js' }),
      'resolver.js': RESOLVER,
      'a.test.js': PASS,
      'b.test.js': PASS,
    }
    const { jest: expected, provino: got } = await sameAsJest(files, WORKERS)
    assert.equal(expected.code, 1)
    for (const ended of [expected, got]) {
      assert.match(ended.stderr, /PASS \.?\/?a\.test\.js/)
      assert.ok(ended.stderr.includes(COORDINATOR_ONLY_FAILURE), ended.stderr)
      // The scheduler threw before `onRunComplete`: the files' results, the error, no totals.
      assert.ok(!ended.stderr.includes('Test Suites:'), ended.stderr)
    }
  })

  it('no project is cleaned: every resolver is built before the first cleanup', async () => {
    const files = {
      ...BASE,
      'jest.config.json': JSON.stringify({ projects: ['<rootDir>/a', '<rootDir>/b'] }),
      ...project('a', { snapshotResolver: '<rootDir>/resolver.js' }),
      'a/resolver.js': RESOLVER,
      ...project('b'),
    }
    const { jest: expected } = await sameAsJest(files, [...WORKERS, '-u'])
    assert.equal(expected.code, 1)
    assert.ok(expected.left.includes('b/__snapshots__/gone.test.js.snap'), 'Jest cleaned nothing')
  })
})

describe('the crawl sees the files Jest’s haste map sees', () => {
  const orphan = (path: string): Files => ({ [path]: SNAP })
  const base: Files = { ...BASE, 'a.test.js': PASS }

  // Jest 30's haste map walks with fdir (`forceNodeFilesystemAPI: true`), which tests a
  // directory's own path against the ignore pattern too, so an anchored `/dir$` hides `dir/`.
  it('a modulePathIgnorePatterns entry hides a directory by its own path, and files by theirs', async () => {
    const files = {
      ...base,
      'jest.config.json': JSON.stringify({ modulePathIgnorePatterns: ['/dir$', '/hidden/'] }),
      ...orphan('dir/__snapshots__/x.test.js.snap'),
      ...orphan('hidden/__snapshots__/y.test.js.snap'),
      ...orphan('shown/__snapshots__/z.test.js.snap'),
    }
    const { jest: expected } = await sameAsJest(files, CI_OFF)
    const listed = snapshotLines(expected.stderr).join('\n')
    assert.ok(listed.includes('shown/__snapshots__'), listed)
    assert.ok(!listed.includes('dir/') && !listed.includes('hidden/'), listed)
  })

  it('node_modules at any depth and the version-control directories are not crawled', async () => {
    const files = {
      ...base,
      ...orphan('node_modules/pkg/__snapshots__/a.test.js.snap'),
      ...orphan('src/node_modules/pkg/__snapshots__/b.test.js.snap'),
      ...orphan('.git/__snapshots__/c.test.js.snap'),
      ...orphan('sub/.hg/__snapshots__/d.test.js.snap'),
      ...orphan('sub/.sl/__snapshots__/e.test.js.snap'),
      ...orphan('sub/.github/__snapshots__/f.test.js.snap'),
      ...orphan('sub/x.git/__snapshots__/g.test.js.snap'),
      ...orphan('my_node_modules/__snapshots__/h.test.js.snap'),
    }
    const { jest: expected } = await sameAsJest(files, [...CI_OFF, '-u'])
    assert.deepEqual(expected.left, [
      '.git/__snapshots__/c.test.js.snap',
      'node_modules/pkg/__snapshots__/a.test.js.snap',
      'src/node_modules/pkg/__snapshots__/b.test.js.snap',
      'sub/.hg/__snapshots__/d.test.js.snap',
      'sub/.sl/__snapshots__/e.test.js.snap',
    ])
  })

  it('only a name that ends in .snap is a snapshot file, case included', async () => {
    const files = {
      ...base,
      ...orphan('__snapshots__/a.test.js.SNAP'),
      ...orphan('__snapshots__/b.test.js.snap.bak'),
      ...orphan('__snapshots__/c.test.js.snap'),
    }
    await sameAsJest(files, CI_OFF)
  })

  it('a symlinked directory is not followed', async () => {
    const files = { ...base, ...orphan('real/__snapshots__/x.test.js.snap') }
    const [one, two] = [await tree(files), await tree(files)]
    await symlink(join(one, 'real'), join(one, 'link'))
    await symlink(join(two, 'real'), join(two, 'link'))
    const expected = await jest(one, CI_OFF)
    assert.ok(snapshotLines(expected.stderr).some((line) => line.includes('real/')))
    assert.ok(!snapshotLines(expected.stderr).some((line) => line.includes('link/')))
    const got = await provino(two, CI_OFF)
    assert.deepEqual(snapshotLines(got.stderr), snapshotLines(expected.stderr))
  })
})
