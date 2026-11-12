// `provino-harness corpus` over a temporary work directory, with fakes for the machine-facing
// parts: the sandbox probe, the package manager and the runner. The pieces behind each action have
// their own tests under `corpus/`; here it is the command's decisions: what it refuses, what it
// skips, what it writes, and its exit codes.
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { type CorpusRepo, defaultManifestPath, readCorpusManifest } from '../corpus/manifest.ts'
import { repoPaths } from '../corpus/paths.ts'
import { runReference } from '../corpus/run.ts'
import { fakeDeps, finished, tempDir, writeTree } from '../corpus/test-support.ts'
import { HarnessError } from '../errors.ts'
import { parseCommandLine } from '../internal/cli-args.ts'
import { runProcess } from '../run-process.ts'
import type { SubjectResult } from '../run-subject.ts'
import { makeFile, makeRun, makeTest } from '../test-support.ts'
import { type CorpusEnvironment, corpusCommand } from './corpus.ts'

const REPO = 'jest-extended'
const SUBJECT = 'jest-extended'
const TODAY = '2026-11-12'
const manifest = await readCorpusManifest()
const found = manifest.repos.find((candidate) => candidate.id === REPO)
if (found === undefined) throw new Error(`the manifest has no ${REPO}`)
const repo: CorpusRepo = found

function command(...argv: string[]) {
  const parsed = parseCommandLine(['corpus', ...argv])
  assert.equal(parsed.command, 'corpus')
  if (parsed.command !== 'corpus') throw new Error('unreachable')
  return parsed
}

/** One status per test title, for run number `n`. */
type Plan = (n: number) => Record<string, 'passed' | 'failed'>

const STEADY: Plan = () => ({ a: 'passed', b: 'passed' })

interface Harness {
  readonly work: string
  readonly corpusDir: string
  readonly paths: ReturnType<typeof repoPaths>
  readonly started: number[]
  readonly out: string[]
  readonly err: string[]
  readonly env: { -readonly [K in keyof CorpusEnvironment]?: CorpusEnvironment[K] }
  run(...argv: string[]): Promise<number>
}

/** A work directory with an extracted tree, and an environment whose runner follows `plan`. */
async function setup(
  options: {
    plan?: Plan
    probe?: CorpusEnvironment['probe']
    deps?: CorpusEnvironment['deps']
    manifestPath?: string
  } = {},
): Promise<Harness> {
  const work = await tempDir('cmd')
  const corpusDir = await tempDir('cmd-committed')
  const paths = repoPaths(work, repo)
  await writeTree(paths.src, { 'package.json': '{}' })
  await writeFile(paths.srcMarker, `${repo.sha}\n`)
  const started: number[] = []
  const plan = options.plan ?? STEADY
  const real = { run: runProcess }
  const env: Harness['env'] = {
    workRoot: work,
    corpusDir,
    manifestPath: options.manifestPath ?? defaultManifestPath(),
    now: () => new Date(`${TODAY}T10:00:00Z`),
    deps: options.deps ?? real,
    probe: options.probe ?? (async () => ({ ok: true, lines: ['  tcp blocked'], problems: [] })),
    runReference: (r, subject, n, runOptions) => {
      started.push(n)
      return runReference(r, subject, n, {
        ...runOptions,
        deps: real,
        unsandboxed: true,
        runSubject: async (subjectOptions): Promise<SubjectResult> => ({
          run: makeRun(
            [
              makeFile(
                'src/a.test.js',
                Object.entries(plan(n)).map(([title, status]) =>
                  makeTest('src/a.test.js', [title], { status }),
                ),
              ),
            ],
            { suite: subjectOptions.suite },
          ),
          runnerVersion: '30.5.2',
          exitCode: 0,
          rawPath: '',
          raw: '',
          process: finished(0, '', '', { wallMs: 10 }),
        }),
      })
    },
  }
  const out: string[] = []
  const err: string[] = []
  return {
    work,
    corpusDir,
    paths,
    started,
    out,
    err,
    env,
    run: (...argv) =>
      corpusCommand(
        command(...argv),
        { out: (text) => out.push(text), err: (text) => err.push(text) },
        env,
      ),
  }
}

/** The install record `corpus install` leaves, with the offline re-install verified. */
async function recordInstall(h: Harness, offlineOk = true): Promise<void> {
  await mkdir(h.paths.dir, { recursive: true })
  await writeFile(
    h.paths.installRecord,
    JSON.stringify({
      id: repo.id,
      sha: repo.sha,
      packageManager: { name: 'npm', version: 'bundled with Node' },
      command: ['npm', 'ci'],
      wallMs: 4000,
      installedAt: '2026-11-12T09:00:00.000Z',
      fingerprint: 'f'.repeat(64),
      fingerprintFiles: 3,
      runnerVersions: { [SUBJECT]: '30.5.2' },
      ...(offlineOk
        ? {
            offline: {
              ok: true,
              wallMs: 900,
              verifiedAt: '2026-11-12T09:30:00.000Z',
              fingerprint: 'f'.repeat(64),
            },
          }
        : {}),
    }),
  )
}

const text = (lines: readonly string[]) => lines.join('')

test('probe prints each attempt and says the sandbox holds', async () => {
  const h = await setup()
  assert.equal(await h.run('probe'), 0)
  assert.match(text(h.out), /tcp blocked/)
  assert.match(text(h.out), /the sandbox holds/)
})

test('a probe that finds a leak ends the command with 1 and prints why', async () => {
  const h = await setup({
    probe: () =>
      Promise.reject(
        new HarnessError('HARNESS_CORPUS_SANDBOX_LEAK', 'tcp connected under the profile'),
      ),
  })
  assert.equal(await h.run('probe'), 1)
  assert.match(text(h.err), /HARNESS_CORPUS_SANDBOX_LEAK/)
  assert.doesNotMatch(text(h.out), /the sandbox holds/)
})

test('run refuses when the probe throws, and starts nothing', async () => {
  const h = await setup({
    probe: () => Promise.reject(new HarnessError('HARNESS_CORPUS_SANDBOX_LEAK', 'leak')),
  })
  await recordInstall(h)
  assert.equal(await h.run('run', REPO), 1)
  assert.deepEqual(h.started, [])
  assert.match(text(h.err), /leak/)
})

test('run probes before every repository, and refuses one that is not installed', async () => {
  let probes = 0
  const h = await setup({
    probe: async () => {
      probes++
      return { ok: true, lines: [], problems: [] }
    },
  })
  assert.equal(await h.run('run', REPO), 1)
  assert.equal(probes, 1)
  assert.deepEqual(h.started, [])
  assert.match(text(h.err), /not installed at \w+ .*run "corpus install jest-extended" first/)
})

test('run makes the runs per subject, skips finished ones and redoes them with --force', async () => {
  const h = await setup()
  await recordInstall(h)
  assert.equal(await h.run('run', REPO, '--runs', '2'), 0)
  assert.deepEqual(h.started, [1, 2])
  assert.match(text(h.out), /ran {2}jest-extended #1: 2 tests \(passed 2\)/)
  h.started.length = 0
  h.out.length = 0
  assert.equal(await h.run('run', REPO, '--runs', '3'), 0)
  assert.deepEqual(h.started, [3], 'runs 1 and 2 are on disk')
  assert.match(text(h.out), /have jest-extended #1/)
  h.started.length = 0
  assert.equal(await h.run('run', REPO, '--runs', '2', '--force'), 0)
  assert.deepEqual(h.started, [1, 2])
})

test('run notes an offline re-install that has not been verified, but still runs', async () => {
  const h = await setup()
  await recordInstall(h, false)
  assert.equal(await h.run('run', REPO, '--runs', '2'), 0)
  assert.match(text(h.out), /note jest-extended: the offline re-install has not been verified/)
})

test('a run that fails is reported, stops that subject and exits 1', async () => {
  const h = await setup()
  await recordInstall(h)
  h.env.runReference = () => {
    h.started.push(0)
    return Promise.reject(new HarnessError('HARNESS_CORPUS_RUN_FAILED', 'prepare exited 2'))
  }
  assert.equal(await h.run('run', REPO, '--runs', '3'), 1)
  assert.deepEqual(h.started, [0], 'the later runs of the subject are not tried')
  assert.match(text(h.out), /FAIL jest-extended #1/)
  assert.match(text(h.err), /prepare exited 2/)
})

test('an unexpected error is not swallowed as a failed repository', async () => {
  const h = await setup()
  await recordInstall(h)
  h.env.runReference = () => Promise.reject(new TypeError('a bug'))
  await assert.rejects(h.run('run', REPO), TypeError)
})

test('flaky writes flaky.json from the runs, and needs at least two', async () => {
  const h = await setup({ plan: (n) => ({ a: 'passed', b: n === 2 ? 'failed' : 'passed' }) })
  await recordInstall(h)
  assert.equal(await h.run('flaky', REPO), 1, 'no runs yet')
  assert.match(text(h.err), /0 runs on disk, 2 or more needed/)
  await h.run('run', REPO, '--runs', '3')
  assert.equal(await h.run('flaky', REPO), 0)
  const flaky = JSON.parse(await readFile(path.join(h.corpusDir, SUBJECT, 'flaky.json'), 'utf8'))
  assert.deepEqual(flaky, { keys: ['src/a.test.js::b#0'] })
  assert.match(text(h.out), /jest-extended: 1 flaky of 2 tests/)
})

test('self-diff exits 0 on identical runs and 1 on a status change the flaky list does not name', async () => {
  const steady = await setup()
  await recordInstall(steady)
  await steady.run('run', REPO, '--runs', '3')
  assert.equal(await steady.run('self-diff', REPO, '--today', TODAY), 1, 'no flaky.json yet')
  assert.match(text(steady.err), /no flaky\.json; run "corpus flaky jest-extended" first/)
  await steady.run('flaky', REPO)
  assert.equal(await steady.run('self-diff', REPO, '--today', TODAY), 0)
  assert.match(text(steady.out), /jest-extended 1-2: status 2\/2.*unexplained diffs 0/)

  const noisy = await setup({ plan: (n) => ({ a: 'passed', b: n === 2 ? 'failed' : 'passed' }) })
  await recordInstall(noisy)
  await mkdir(path.join(noisy.corpusDir, SUBJECT), { recursive: true })
  await writeFile(path.join(noisy.corpusDir, SUBJECT, 'flaky.json'), '{"keys":[]}\n')
  assert.equal(await noisy.run('self-diff', REPO, '--today', TODAY), 1)
  assert.match(text(noisy.out), /FAIL jest-extended/)
})

test('self-diff needs two runs on disk', async () => {
  const h = await setup()
  await recordInstall(h)
  await h.run('run', REPO, '--runs', '2')
  await rm0(path.join(h.paths.runs, SUBJECT, '2'))
  await mkdir(path.join(h.corpusDir, SUBJECT), { recursive: true })
  await writeFile(path.join(h.corpusDir, SUBJECT, 'flaky.json'), '{"keys":[]}\n')
  assert.equal(await h.run('self-diff', REPO), 1)
  assert.match(text(h.err), /1 runs on disk, 2 or more needed/)
})

test('gate passes for 3 identical runs with a verified offline re-install, and writes the JSON report', async () => {
  // 100 tests so that nothing flaky would matter; every one passes in every run.
  const plan: Plan = () =>
    Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, 'passed' as const]))
  const h = await setup({ plan })
  await recordInstall(h)
  await h.run('run', REPO, '--runs', '3')
  await h.run('flaky', REPO)
  const out = path.join(h.work, 'report', 'g0.json')
  assert.equal(await h.run('gate', REPO, '--today', TODAY, '--out', out), 0)
  assert.match(text(h.out), /G0 on the pilot: PASS/)
  const report = JSON.parse(await readFile(out, 'utf8'))
  assert.equal(report.pass, true)
  assert.equal(report.subjects[0].subject, SUBJECT)
  assert.equal(report.subjects[0].comparedTests, 100)
})

test('gate exits 1 when the offline re-install was never verified', async () => {
  const h = await setup()
  await recordInstall(h, false)
  await h.run('run', REPO, '--runs', '3')
  await h.run('flaky', REPO)
  const out = path.join(h.work, 'g0.json')
  assert.equal(await h.run('gate', REPO, '--today', TODAY, '--out', out), 1)
  assert.match(text(h.out), /G0 on the pilot: FAIL/)
  assert.ok((await stat(out)).isFile(), 'the report is written for a failure too')
})

test('gate exits 1 without a flaky list, naming the command that makes it', async () => {
  const h = await setup()
  await recordInstall(h)
  await h.run('run', REPO, '--runs', '3')
  assert.equal(await h.run('gate', REPO, '--out', path.join(h.work, 'g0.json')), 1)
  assert.match(text(h.err), /no flaky\.json; run "corpus flaky jest-extended" first/)
})

test('clean removes the tree, runs and install record; --everything removes the repository directory', async () => {
  const h = await setup()
  await recordInstall(h)
  await h.run('run', REPO, '--runs', '2')
  await writeFile(path.join(h.paths.dir, `${repo.sha}.tar.gz`), 'tarball')
  assert.equal(await h.run('clean', REPO), 0)
  for (const gone of [h.paths.src, h.paths.srcMarker, h.paths.runs, h.paths.installRecord]) {
    await assert.rejects(stat(gone), gone)
  }
  assert.ok(
    (await stat(path.join(h.paths.dir, `${repo.sha}.tar.gz`))).isFile(),
    'the tarball stays',
  )
  assert.equal(await h.run('clean', REPO, '--everything'), 0)
  await assert.rejects(stat(h.paths.dir))
})

test('fetch reports a repository that failed, counts the verified ones, and exits 1', async () => {
  const h = await setup({ deps: fakeDeps(() => finished(22, '', 'curl: (22) 404')) })
  await rm0(h.paths.dir)
  assert.equal(await h.run('fetch', REPO, '--verify-only'), 1)
  assert.match(text(h.out), /FAIL jest-extended/)
  assert.match(text(h.out), /0 of 1 tarballs verified/)
  assert.match(text(h.err), /HARNESS_CORPUS_FETCH_FAILED/)
})

test('install fails for a repository with no extracted tree', async () => {
  const h = await setup()
  await rm0(h.paths.srcMarker)
  assert.equal(await h.run('install', REPO), 1)
  assert.match(text(h.err), /HARNESS_CORPUS_NOT_INSTALLED/)
})

test('install --offline probes the sandbox first', async () => {
  let probed = false
  const h = await setup({
    probe: async () => {
      probed = true
      throw new HarnessError('HARNESS_CORPUS_SANDBOX_LEAK', 'leak')
    },
  })
  assert.equal(await h.run('install', REPO, '--offline'), 1)
  assert.equal(probed, true)
})

test('pin leaves the manifest as it was when a repository stops, and says so', async () => {
  const dir = await tempDir('cmd-pin')
  const copy = path.join(dir, 'manifest.json')
  await cp(defaultManifestPath(), copy)
  const before = await readFile(copy, 'utf8')
  const h = await setup({
    manifestPath: copy,
    deps: fakeDeps((call) => (call.command === 'gh' ? finished(1, '', 'HTTP 422') : undefined)),
  })
  assert.equal(await h.run('pin', REPO), 1)
  assert.match(text(h.out), /FAIL jest-extended/)
  assert.match(text(h.err), /the manifest was not written/)
  assert.equal(await readFile(copy, 'utf8'), before)
})

test('an id that is not in the manifest is a usage error, exit 2', async () => {
  const h = await setup()
  assert.equal(await h.run('flaky', 'no-such-repo'), 2)
  assert.match(text(h.err), /no corpus repository or subject "no-such-repo"/)
})

/** Removes a path the way a test needs, ignoring a missing one. */
async function rm0(target: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(target, { recursive: true, force: true })
}
