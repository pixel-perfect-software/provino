// T12.10's reference runs with a fake `runSubject` and fake `cp`: the clone, the prepare steps, what
// a run leaves on disk, the sidecar check and the listing of finished runs. No runner starts.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

test('cloneTree copies the tree, falling back to a plain copy when the clone fails', async () => {
  const dir = await tempDir('clone')
  await writeTree(path.join(dir, 'src'), { 'a/b.txt': 'x' })
  const cloned = fakeDeps(() => undefined, REAL)
  await cloneTree(path.join(dir, 'src'), path.join(dir, 'out/one'), cloned)
  assert.equal(await readFile(path.join(dir, 'out/one/a/b.txt'), 'utf8'), 'x')
  const fallback = fakeDeps(
    (call: Call) => (call.args.includes('-cR') ? finished(1) : undefined),
    REAL,
  )
  await cloneTree(path.join(dir, 'src'), path.join(dir, 'out/two'), fallback)
  assert.equal(await readFile(path.join(dir, 'out/two/a/b.txt'), 'utf8'), 'x')
  assert.deepEqual(
    fallback.calls.map((call) => call.args[0]),
    ['-cR', '-R'],
  )
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
