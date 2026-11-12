// T12.10's reference runs with a fake `runSubject` and fake `cp`: the clone, the prepare steps, what
// a run leaves on disk, the sidecar check and the listing of finished runs. No runner starts.
import assert from 'node:assert/strict'
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HarnessError } from '../errors.ts'
import { runProcess } from '../run-process.ts'
import type { SubjectOptions, SubjectResult } from '../run-subject.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { DEFAULT_SUBJECT_TIMEOUT_MS } from './manifest.ts'
import { repoPaths } from './paths.ts'
import {
  checkSidecar,
  cloneTree,
  cloneUnsupportedReason,
  hasRun,
  listRuns,
  readRunMeta,
  resolvePrepareCommand,
  runFile,
  runReference,
} from './run.ts'
import {
  type Call,
  fakeDeps,
  finished,
  makeRepo,
  makeSubject,
  tempDir,
  writeTree,
} from './test-support.ts'

const NOW = () => new Date('2026-11-12T10:00:00Z')
const REAL = { run: runProcess }

function hasCode(code: string) {
  return (error: unknown) => error instanceof HarnessError && error.code === code
}

/** A work directory whose repository has an installed tree. */
async function workWithTree(files: Record<string, string> = {}) {
  const repo = makeRepo()
  const work = await tempDir('run')
  const paths = repoPaths(work, repo)
  await writeTree(paths.src, { 'package.json': '{}', 'src/a.test.js': '', ...files })
  return { repo, work, paths }
}

function subjectResult(overrides: Partial<SubjectResult> = {}): SubjectResult {
  return {
    run: makeRun([
      makeFile('src/a.test.js', [
        makeTest('src/a.test.js', ['a']),
        makeTest('src/a.test.js', ['b'], { status: 'failed' }),
      ]),
    ]),
    runnerVersion: '30.5.2',
    exitCode: 1,
    rawPath: '/x/raw.json',
    raw: '{}',
    process: finished(1, '', '', { wallMs: 250 }),
    ...overrides,
  }
}

/** The tools a clone is tried with, in the order `cloneTree` tries them. */
const toolOf = (call: Call) => (call.command === 'cp' ? `cp ${call.args[0]}` : call.command)

test('cloneTree clones the whole tree with one clonefile call through python3, and tries nothing else', async () => {
  const dir = await tempDir('clone')
  const deps = fakeDeps(() => finished(0))
  const result = await cloneTree(path.join(dir, 'src'), path.join(dir, 'out/one'), deps)
  assert.deepEqual(result, { method: 'clonefile' })
  assert.equal(deps.calls.length, 1)
  const [call] = deps.calls
  assert.equal(call?.command, '/usr/bin/python3')
  // An argv array, no shell: the paths are arguments, never part of the program text.
  assert.deepEqual(call?.args.slice(0, 1), ['-c'])
  assert.match(call?.args[1] ?? '', /clonefile/)
  assert.deepEqual(call?.args.slice(2), [path.join(dir, 'src'), path.join(dir, 'out/one')])
})

test('each way the python clone can fail falls back to cp -cR, then to a plain copy', async () => {
  const dir = await tempDir('clone-fallback')
  await writeTree(path.join(dir, 'src'), { 'a/b.txt': 'x' })
  const failures: [string, (call: Call) => Promise<never> | ReturnType<typeof finished>][] = [
    ['python3 is missing', () => Promise.reject(new Error('spawn /usr/bin/python3 ENOENT'))],
    ['not APFS (ENOTSUP, 45)', () => finished(45)],
    ['another volume (EXDEV, 18)', () => finished(18)],
    ['the destination exists (EEXIST, 17)', () => finished(17)],
    ['python3 fails some other way', () => finished(1, '', 'Traceback')],
  ]
  for (const [name, fail] of failures) {
    const out = path.join(dir, `out-${name.length}`)
    const deps = fakeDeps(
      (call: Call) => (call.command === '/usr/bin/python3' ? fail(call) : undefined),
      REAL,
    )
    const result = await cloneTree(path.join(dir, 'src'), out, deps)
    assert.equal(result.method, 'cp-c', name)
    assert.deepEqual(deps.calls.map(toolOf), ['/usr/bin/python3', 'cp -cR'], name)
    assert.equal(await readFile(path.join(out, 'a/b.txt'), 'utf8'), 'x', name)
  }
  // The clone fails too: every byte is copied, and the result says why.
  const out = path.join(dir, 'out-copy')
  const deps = fakeDeps(
    (call: Call) =>
      call.command === '/usr/bin/python3'
        ? finished(45)
        : call.args[0] === '-cR'
          ? finished(1, '', 'clonefile failed: Operation not supported')
          : undefined,
    REAL,
  )
  const copied = await cloneTree(path.join(dir, 'src'), out, deps)
  assert.equal(copied.method, 'copy')
  assert.match(copied.why ?? '', /cp -cR exited 1: clonefile failed: Operation not supported/)
  assert.deepEqual(deps.calls.map(toolOf), ['/usr/bin/python3', 'cp -cR', 'cp -R'])
  assert.equal(await readFile(path.join(out, 'a/b.txt'), 'utf8'), 'x')
})

/** Every file and directory under `dir`, with each file's text, by relative path. */
async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const relative = path.relative(dir, full)
      if (entry.isDirectory()) {
        found[`${relative}/`] = ''
        await walk(full)
      } else if (entry.isSymbolicLink()) found[relative] = `-> ${await readlink(full)}`
      else found[relative] = await readFile(full, 'utf8')
    }
  }
  await walk(dir)
  return found
}

test('a real clone gives a tree equal to the source (skipped where this volume cannot clone)', async (t) => {
  const dir = await tempDir('clone-real')
  const src = path.join(dir, 'src')
  await writeTree(src, {
    'a/b.txt': 'x',
    'node_modules/p/index.js': 'module.exports = 1',
    'empty.txt': '',
  })
  await symlink('b.txt', path.join(src, 'a/link'))
  const result = await cloneTree(src, path.join(dir, 'out/tree'))
  if (result.method !== 'clonefile') {
    t.skip(
      `clonefile did not work here (${result.method}${result.why === undefined ? '' : `: ${result.why}`}); the tree was copied instead`,
    )
  }
  assert.deepEqual(await snapshotOf(path.join(dir, 'out/tree')), await snapshotOf(src))
})

test('cloneUnsupportedReason is undefined when a clone works and says why when only a full copy does', async () => {
  const work = await tempDir('clone-check')
  assert.equal(
    await cloneUnsupportedReason(
      work,
      fakeDeps(() => finished(0)),
    ),
    undefined,
  )
  const copyOnly = fakeDeps(
    (call: Call) =>
      call.command === 'cp' && call.args[0] === '-cR'
        ? finished(1, '', 'not supported')
        : call.command === 'cp'
          ? undefined
          : finished(45),
    REAL,
  )
  assert.match(
    (await cloneUnsupportedReason(work, copyOnly)) ?? '',
    /cp -cR exited 1: not supported/,
  )
  await assert.rejects(stat(path.join(work, '_clone-probe')), { code: 'ENOENT' })
})

test('cloneTree that cannot copy at all is HARNESS_CORPUS_RUN_FAILED', async () => {
  const dir = await tempDir('clone-fail')
  await assert.rejects(
    cloneTree(
      path.join(dir, 'src'),
      path.join(dir, 'out'),
      fakeDeps(() => finished(1, '', 'ENOSPC')),
    ),
    hasCode('HARNESS_CORPUS_RUN_FAILED'),
  )
})

test("a prepare command is found in the subject's .bin, then the root's, else by name; node is this node", () => {
  const tree = '/tree'
  const step = { command: 'gulp', args: [], cwd: 'packages/a' }
  const present =
    (...files: string[]) =>
    (file: string) =>
      files.includes(file)
  assert.equal(
    resolvePrepareCommand(
      step,
      tree,
      present('/tree/packages/a/node_modules/.bin/gulp', '/tree/node_modules/.bin/gulp'),
    ),
    '/tree/packages/a/node_modules/.bin/gulp',
  )
  assert.equal(
    resolvePrepareCommand(step, tree, present('/tree/node_modules/.bin/gulp')),
    '/tree/node_modules/.bin/gulp',
  )
  assert.equal(resolvePrepareCommand(step, tree, present()), 'gulp')
  assert.equal(
    resolvePrepareCommand({ command: 'node', args: [] }, tree, present()),
    process.execPath,
  )
})

test('the sidecar check lists the files with output the converted run has no console for', () => {
  const root = '/clone'
  const sidecar = [
    { file: '/clone/src/a.test.js', stream: 'stdout', text: 'one' },
    { file: '/clone/src/b.test.js', stream: 'stdout', text: 'two' },
    { file: '/clone/src/c.test.js', stream: 'stderr', text: 'three' },
    { stream: 'stdout', text: 'no file' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n')
  const run = makeRun([
    makeFile('src/a.test.js', [makeTest('src/a.test.js', ['t'])]),
    makeFile('src/b.test.js', [
      makeTest('src/b.test.js', ['t'], { console: [{ stream: 'stdout', text: 'two' }] }),
    ]),
  ])
  const check = checkSidecar(sidecar, run, root)
  assert.deepEqual(check, { files: 3, withConsole: 1, missing: ['src/a.test.js', 'src/c.test.js'] })
  assert.deepEqual(checkSidecar('', run, root), { files: 0, withConsole: 0, missing: [] })
})

test('a console entry on the file counts as console for it', () => {
  const run = makeRun([
    {
      ...makeFile('src/a.test.js', [makeTest('src/a.test.js', ['t'])]),
      console: [{ stream: 'stdout', text: 'x' }],
    },
  ])
  const sidecar = JSON.stringify({ file: '/clone/src/a.test.js', stream: 'stdout', text: 'x' })
  assert.equal(checkSidecar(sidecar, run, '/clone').withConsole, 1)
})

test('the sidecar check reads the real paths a runner prints under a symlinked root', () => {
  const run = makeRun([
    {
      ...makeFile('src/a.test.js', [makeTest('src/a.test.js', ['t'])]),
      console: [{ stream: 'stdout', text: 'x' }],
    },
  ])
  const sidecar = JSON.stringify({
    file: '/private/tmp/clone/src/a.test.js',
    stream: 'stdout',
    text: 'x',
  })
  assert.deepEqual(checkSidecar(sidecar, run, '/tmp/clone', ['/private/tmp/clone']), {
    files: 1,
    withConsole: 1,
    missing: [],
  })
})

test('runReference does not fail the sidecar check when the work root has a symlink in it', async () => {
  const { repo, work } = await workWithTree()
  const link = `${work}-link`
  await symlink(work, link)
  const meta = await runReference(repo, makeSubject(), 1, {
    workRoot: link,
    deps: fakeDeps(() => undefined, REAL),
    unsandboxed: true,
    runSubject: async (options) => {
      const real = await realpath(options.cwd)
      const entry = { file: path.join(real, 'src/a.test.js'), stream: 'stdout', text: 'x' }
      return subjectResult({
        run: makeRun([
          {
            ...makeFile('src/a.test.js', [makeTest('src/a.test.js', ['a'])]),
            console: [{ stream: 'stdout', text: 'x' }],
          },
        ]),
        sidecar: `${JSON.stringify(entry)}\n`,
      })
    },
  })
  assert.deepEqual(meta.sidecar, { files: 1, withConsole: 1, missing: [] })
})

test('a run that fails after the clone removes the clone unless keepTree is set', async () => {
  const { repo, work, paths } = await workWithTree()
  const tree = path.join(paths.runs, 'demo', '1', 'tree')
  const common = {
    workRoot: work,
    deps: fakeDeps(() => undefined, REAL),
    unsandboxed: true,
    runSubject: async () => {
      assert.ok((await stat(tree)).isDirectory())
      throw new HarnessError('HARNESS_RUNNER_FAILED', 'boom')
    },
  }
  await assert.rejects(
    runReference(repo, makeSubject(), 1, common),
    hasCode('HARNESS_RUNNER_FAILED'),
  )
  await assert.rejects(stat(tree), 'the clone is gone')
  await assert.rejects(
    runReference(repo, makeSubject(), 1, { ...common, keepTree: true }),
    hasCode('HARNESS_RUNNER_FAILED'),
  )
  assert.ok((await stat(tree)).isDirectory(), 'keepTree keeps it')
})

test('runReference clones the tree, runs the subject in it and writes run.json and meta.json', async () => {
  const { repo, work, paths } = await workWithTree()
  const subject = makeSubject({ env: { EXTRA: '1' } })
  const seen: SubjectOptions[] = []
  const sidecar = JSON.stringify({ file: '', stream: 'stdout', text: '' })
  const meta = await runReference(repo, subject, 1, {
    workRoot: work,
    deps: fakeDeps(() => undefined, REAL),
    unsandboxed: true,
    now: NOW,
    runSubject: async (options) => {
      seen.push(options)
      // The clone is really there, with the repository's files.
      assert.equal(await readFile(path.join(options.cwd, 'src/a.test.js'), 'utf8'), '')
      return subjectResult({ sidecar: `${sidecar}\n` })
    },
  })
  const options = seen[0]
  assert.ok(options !== undefined)
  const dir = path.join(paths.runs, 'demo', '1')
  assert.equal(options.cwd, path.join(dir, 'tree'))
  assert.equal(options.rootDir, path.join(dir, 'tree'))
  assert.equal(options.suite, 'demo')
  assert.deepEqual(options.argv, ['--ci'])
  assert.equal(options.timeoutMs, DEFAULT_SUBJECT_TIMEOUT_MS)
  assert.equal(options.outDir, path.join(dir, 'out'))
  assert.equal(options.env.EXTRA, '1')
  assert.equal(options.env.HOME, path.join(dir, 'home'))
  assert.ok(options.env.PATH?.startsWith(path.join(dir, 'tree', 'node_modules', '.bin')))
  assert.equal(options.wrap, undefined, 'unsandboxed')
  assert.ok(options.fired instanceof Set)
  assert.equal(meta.tests, 2)
  assert.equal(meta.files, 1)
  assert.deepEqual(meta.statuses, { passed: 1, failed: 1 })
  assert.equal(meta.exitCode, 1)
  assert.equal(meta.runMs, 250)
  assert.equal(meta.startedAt, '2026-11-12T10:00:00.000Z')
  assert.equal(meta.runnerVersion, '30.5.2')
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')), meta)
  assert.equal(JSON.parse(await readFile(runFile(paths, 'demo', 1), 'utf8')).suite, 'unit/suite')
  await assert.rejects(stat(path.join(dir, 'tree')), 'the clone is deleted afterwards')
  assert.deepEqual(await readRunMeta(paths, 'demo', 1), meta)
})

test('keepTree leaves the clone, and a re-run replaces the run directory', async () => {
  const { repo, work, paths } = await workWithTree()
  const common = {
    workRoot: work,
    deps: fakeDeps(() => undefined, REAL),
    unsandboxed: true,
    runSubject: async () => subjectResult(),
  }
  await runReference(repo, makeSubject(), 1, { ...common, keepTree: true })
  const stale = path.join(paths.runs, 'demo', '1', 'stale.txt')
  await writeFile(stale, 'old')
  assert.ok((await stat(path.join(paths.runs, 'demo', '1', 'tree', 'package.json'))).isFile())
  await runReference(repo, makeSubject(), 1, common)
  await assert.rejects(stat(stale))
})

test('the sandboxed run wraps the runner and the prepare steps in the same profile', async () => {
  const { repo, work, paths } = await workWithTree({ 'node_modules/.bin/build': '#!/bin/sh\n' })
  const subject = makeSubject({
    prepare: [{ command: 'build', args: ['--fast'] }],
  })
  const deps = fakeDeps(() => undefined, REAL)
  let wrapped: { command: string; args: readonly string[] } | undefined
  const prepared: Call[] = []
  const spy = fakeDeps((call: Call) => {
    if (call.command === '/usr/bin/sandbox-exec') {
      prepared.push(call)
      return finished(0)
    }
    return undefined
  }, deps)
  await runReference(repo, subject, 1, {
    workRoot: work,
    deps: spy,
    runSubject: async (options) => {
      wrapped = options.wrap?.('node', ['x.js'])
      return subjectResult()
    },
  })
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0]?.args[0], '-f')
  assert.ok(prepared[0]?.args[2]?.endsWith('node_modules/.bin/build'))
  assert.deepEqual(prepared[0]?.args.slice(3), ['--fast'])
  assert.equal(prepared[0]?.options.cwd, path.join(paths.runs, 'demo', '1', 'tree'))
  assert.equal(wrapped?.command, '/usr/bin/sandbox-exec')
  assert.equal(wrapped?.args[0], '-f')
  assert.equal(wrapped?.args[1], prepared[0]?.args[1], 'one profile for both')
  assert.deepEqual(wrapped?.args.slice(2), ['node', 'x.js'])
})

test('a prepare step that fails, or times out, stops the run before the runner starts', async () => {
  const { repo, work } = await workWithTree()
  const subject = makeSubject({ prepare: [{ command: 'build', args: ['x'] }] })
  let started = false
  const runSubject = async () => {
    started = true
    return subjectResult()
  }
  const fails = fakeDeps(
    (call: Call) => (call.command === 'build' ? finished(2, '', 'boom') : undefined),
    REAL,
  )
  await assert.rejects(
    runReference(repo, subject, 1, { workRoot: work, deps: fails, unsandboxed: true, runSubject }),
    (error: unknown) =>
      hasCode('HARNESS_CORPUS_RUN_FAILED')(error) &&
      String(error).includes('prepare "build x" exited 2') &&
      String(error).includes('boom'),
  )
  const slow = fakeDeps(
    (call: Call) =>
      call.command === 'build' ? finished(null, '', '', { timedOut: true }) : undefined,
    REAL,
  )
  await assert.rejects(
    runReference(repo, subject, 1, { workRoot: work, deps: slow, unsandboxed: true, runSubject }),
    /timed out/,
  )
  assert.equal(started, false)
})

test('a subject deadline in the manifest is passed to the runner', async () => {
  const { repo, work } = await workWithTree()
  let timeout: number | undefined
  await runReference(repo, makeSubject({ timeoutMs: 5_000 }), 1, {
    workRoot: work,
    deps: fakeDeps(() => undefined, REAL),
    unsandboxed: true,
    runSubject: async (options) => {
      timeout = options.timeoutMs
      return subjectResult()
    },
  })
  assert.equal(timeout, 5_000)
})

test('a run that failed to convert leaves no meta.json, so it is not counted as finished', async () => {
  const { repo, work, paths } = await workWithTree()
  await assert.rejects(
    runReference(repo, makeSubject(), 1, {
      workRoot: work,
      deps: fakeDeps(() => undefined, REAL),
      unsandboxed: true,
      runSubject: () => Promise.reject(new HarnessError('HARNESS_RUNNER_FAILED', 'bad json')),
    }),
    /bad json/,
  )
  assert.equal(await hasRun(paths, 'demo', 1), false)
  assert.deepEqual(await listRuns(paths, 'demo'), [])
})

test('listRuns names the finished runs in order; hasRun and readRunMeta agree', async () => {
  const { repo, work, paths } = await workWithTree()
  const common = {
    workRoot: work,
    deps: fakeDeps(() => undefined, REAL),
    unsandboxed: true,
    runSubject: async () => subjectResult(),
  }
  assert.deepEqual(await listRuns(paths, 'demo'), [])
  for (const n of [3, 1, 2]) await runReference(repo, makeSubject(), n, common)
  await mkdir(path.join(paths.runs, 'demo', 'notes'), { recursive: true })
  await mkdir(path.join(paths.runs, 'demo', '4'), { recursive: true })
  assert.deepEqual(
    await listRuns(paths, 'demo'),
    [1, 2, 3],
    'a directory with no meta.json is unfinished',
  )
  assert.equal(await hasRun(paths, 'demo', 2), true)
  assert.equal(await hasRun(paths, 'demo', 4), false)
  assert.equal(await readRunMeta(paths, 'demo', 4), undefined)
  await writeFile(path.join(paths.runs, 'demo', '2', 'meta.json'), '{"subject":"demo"}')
  assert.equal(await readRunMeta(paths, 'demo', 2), undefined, 'a meta.json with fields missing')
  await rm(path.join(paths.runs, 'demo', '1'), { recursive: true })
  assert.deepEqual(await listRuns(paths, 'demo'), [2, 3])
})
