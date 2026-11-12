// T12.10's reference runs: a repository's own runner over a subject, in a fresh clone of the
// installed tree, inside the network-off sandbox. Each run leaves `run.json` (the `NormalizedRun`),
// `meta.json` (times, counts, the sidecar check) and the runner's raw output under
// `<work>/<repo>/runs/<subject>/<n>/`. The tree itself is deleted afterwards.
import { existsSync } from 'node:fs'
import { mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NormalizedRun, TestStatus } from '@provino/types'
import { HarnessError } from '../errors.ts'
import { isNotFound, isRecord, readIfExists } from '../internal/guards.ts'
import { countTests } from '../parse-normalized-run.ts'
import type { CommandWrap } from '../run-process.ts'
import { runSubject, type SubjectOptions, type SubjectResult } from '../run-subject.ts'
import { parseSidecar } from '../sidecar.ts'
import { type CorpusDeps, defaultDeps, exitText, tailOf } from './deps.ts'
import {
  type CorpusRepo,
  type CorpusSubject,
  DEFAULT_SUBJECT_TIMEOUT_MS,
  type PrepareStep,
} from './manifest.ts'
import { homeDir, type RepoPaths, repoPaths, runDir, tmpDir } from './paths.ts'
import { sandboxEnv, sandboxWrap, writeProfile } from './sandbox.ts'

/** The most one `prepare` step may take. */
const PREPARE_TIMEOUT_MS = 20 * 60_000

/**
 * The sidecar check (A3): every file the sidecar saw console output for has console entries in
 * the converted run.
 * @public
 */
export interface SidecarCheck {
  /** Files with at least one sidecar entry. */
  readonly files: number
  /** Of those, files whose converted run has console entries (on the file or a test). */
  readonly withConsole: number
  /** The files that have sidecar entries and no console in the run. */
  readonly missing: readonly string[]
}

/**
 * What one reference run recorded, in `meta.json`.
 * @public
 */
export interface RunMeta {
  readonly repo: string
  readonly subject: string
  readonly n: number
  readonly startedAt: string
  readonly runner: string
  readonly runnerVersion: string
  /** `local`: milliseconds. */
  readonly cloneMs: number
  readonly prepareMs: number
  readonly runMs: number
  readonly exitCode: number | null
  readonly tests: number
  readonly files: number
  readonly statuses: Readonly<Partial<Record<TestStatus, number>>>
  /** The normalization rules that changed any text in this run. */
  readonly fired: readonly string[]
  readonly sidecar: SidecarCheck
}

/**
 * How `runReference` finds its pieces, which tests replace.
 * @public
 */
export interface RunReferenceOptions {
  readonly workRoot: string
  readonly deps?: CorpusDeps
  /** Default: the real `runSubject`. */
  readonly runSubject?: (options: SubjectOptions) => Promise<SubjectResult>
  /** Run without Seatbelt (tests only; the commands never set it). */
  readonly unsandboxed?: boolean
  /** Keep the clone after the run (for looking at what a test left behind). */
  readonly keepTree?: boolean
  readonly now?: () => Date
}

/** The system Python, which macOS ships; `clonefile(2)` has no `cp` flag that gives its one-call form. */
const PYTHON = '/usr/bin/python3'

/**
 * `clonefile(src, dst, 0)` through ctypes: one system call clones the whole tree, where `cp -cR`
 * makes one per file (which is most of a `node_modules` clone's time). Its exit status is the
 * errno, so a failure says why (45 `ENOTSUP`: not APFS; 18 `EXDEV`: another volume; 17 `EEXIST`).
 */
const CLONEFILE_PROGRAM =
  'import ctypes,sys; l=ctypes.CDLL(None,use_errno=True); r=l.clonefile(sys.argv[1].encode(),sys.argv[2].encode(),0); sys.exit(0 if r==0 else ctypes.get_errno() or 1)'

/**
 * How a tree was copied: `clonefile` (one call, copy-on-write), `cp-c` (a clone per file) or
 * `copy` (every byte: 10 to 50 times slower, on a file system that cannot clone).
 * @public
 */
export type CloneMethod = 'clonefile' | 'cp-c' | 'copy'

/**
 * Runs a command that may not even start (no `python3`): not starting is a failure like any other.
 * @returns the result, or `undefined` when the command could not be started
 */
async function attempt(
  deps: CorpusDeps,
  command: string,
  args: readonly string[],
  options: Parameters<CorpusDeps['run']>[2],
) {
  try {
    const result = await deps.run(command, args, options)
    return result.exitCode === 0 ? { ok: true as const } : { ok: false as const, result }
  } catch {
    return { ok: false as const, result: undefined }
  }
}

/**
 * Copies `src` to `dest` as cheaply as the file system allows: a single `clonefile(2)` of the
 * whole tree through `python3`, else `cp -cR`, else a plain `cp -R`. Says which one worked, and
 * for a plain copy why the clone did not (`why`).
 * @public
 */
export async function cloneTree(
  src: string,
  dest: string,
  deps: CorpusDeps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly method: CloneMethod; readonly why?: string }> {
  await mkdir(path.dirname(dest), { recursive: true })
  const options = { cwd: path.dirname(dest), env, timeoutMs: 20 * 60_000 }
  const whole = await attempt(deps, PYTHON, ['-c', CLONEFILE_PROGRAM, src, dest], options)
  if (whole.ok) return { method: 'clonefile' }
  // A failed clone leaves nothing, but the next attempt must find no `dest` either way.
  await rm(dest, { recursive: true, force: true })
  const cloned = await attempt(deps, 'cp', ['-cR', src, dest], options)
  if (cloned.ok) return { method: 'cp-c' }
  await rm(dest, { recursive: true, force: true })
  const copied = await deps.run('cp', ['-R', src, dest], options)
  if (copied.exitCode !== 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_RUN_FAILED',
      `could not copy ${src} to ${dest}: ${tailOf(copied, 300)}`,
    )
  }
  return {
    method: 'copy',
    why:
      cloned.result === undefined
        ? 'cp could not be started'
        : `cp -cR ${exitText(cloned.result)}: ${tailOf(cloned.result, 200)}`,
  }
}

/**
 * Whether a tree under `workRoot` can be cloned, tested once with a small tree: `undefined` when
 * it can, else the reason it cannot (`cloneTree` then copies every byte, for every run).
 * @public
 */
export async function cloneUnsupportedReason(
  workRoot: string,
  deps: CorpusDeps = defaultDeps,
): Promise<string | undefined> {
  const probe = path.join(workRoot, '_clone-probe')
  await rm(probe, { recursive: true, force: true })
  await mkdir(path.join(probe, 'src'), { recursive: true })
  await writeFile(path.join(probe, 'src', 'file'), 'x')
  try {
    const { method, why } = await cloneTree(path.join(probe, 'src'), path.join(probe, 'dest'), deps)
    return method === 'copy' ? (why ?? 'unknown') : undefined
  } finally {
    await rm(probe, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** `command` as the clone finds it: a tool in a `node_modules/.bin` of the subject or the root, else by name. */
export function resolvePrepareCommand(
  step: PrepareStep,
  tree: string,
  exists: (file: string) => boolean,
): string {
  if (step.command === 'node') return process.execPath
  const cwd = path.join(tree, step.cwd ?? '.')
  for (const dir of [
    path.join(cwd, 'node_modules', '.bin'),
    path.join(tree, 'node_modules', '.bin'),
  ]) {
    const candidate = path.join(dir, step.command)
    if (exists(candidate)) return candidate
  }
  return step.command
}

/**
 * Which files the sidecar saw output for, and whether the converted run has console entries for
 * each of them (A3). `rootDir` makes the sidecar's absolute paths relative, as the run's are; the
 * runners print real paths, so `extraRoots` (the realpath of a root that has a symlink in it) is
 * tried too, as the conversion does.
 * @public
 */
export function checkSidecar(
  sidecarText: string,
  run: NormalizedRun,
  rootDir: string,
  extraRoots: readonly string[] = [],
): SidecarCheck {
  const withOutput = new Set<string>()
  for (const entry of parseSidecar(sidecarText, 'sidecar')) {
    if (entry.file === undefined) continue
    withOutput.add(relativeToRoots(entry.file, [rootDir, ...extraRoots]))
  }
  const missing: string[] = []
  let withConsole = 0
  for (const file of [...withOutput].toSorted()) {
    const found = run.files.find((candidate) => candidate.file === file)
    const has =
      found !== undefined &&
      ((found.console?.length ?? 0) > 0 ||
        found.tests.some((test) => (test.console?.length ?? 0) > 0))
    if (has) withConsole++
    else missing.push(file)
  }
  return { files: withOutput.size, withConsole, missing }
}

/** `file` relative to the first root that holds it (the first root's spelling if none does). */
function relativeToRoots(file: string, roots: readonly string[]): string {
  const relatives = roots.map((root) => path.relative(root, file))
  const inside = relatives.find(
    (relative) => !relative.startsWith('..') && !path.isAbsolute(relative),
  )
  return (inside ?? relatives[0] ?? file).split(path.sep).join('/')
}

function statusCounts(run: NormalizedRun): Partial<Record<TestStatus, number>> {
  const counts: Partial<Record<TestStatus, number>> = {}
  for (const file of run.files) {
    for (const test of file.tests) counts[test.status] = (counts[test.status] ?? 0) + 1
  }
  return counts
}

/**
 * One reference run: a fresh clone of the installed tree, `prepare` steps, then the subject
 * through `runSubject`, both inside the sandbox. A `HARNESS_*` error from the conversion fails the
 * run. The run's directory is replaced, so a re-run starts clean.
 * @public
 */
export async function runReference(
  repo: CorpusRepo,
  subject: CorpusSubject,
  n: number,
  options: RunReferenceOptions,
): Promise<RunMeta> {
  const deps = options.deps ?? defaultDeps
  const run = options.runSubject ?? runSubject
  const paths = repoPaths(options.workRoot, repo)
  const dir = runDir(paths, subject.id, n)
  const tree = path.join(dir, 'tree')
  await rm(dir, { recursive: true, force: true })
  await mkdir(homeDir(dir), { recursive: true })
  await mkdir(tmpDir(dir), { recursive: true })
  const startedAt = (options.now ?? (() => new Date()))()

  try {
    const cloneStart = performance.now()
    await cloneTree(paths.src, tree, deps)
    const cloneMs = Math.round(performance.now() - cloneStart)

    const env = sandboxEnv({
      runDir: dir,
      pathPrefix: [
        path.join(tree, subject.cwd, 'node_modules', '.bin'),
        path.join(tree, 'node_modules', '.bin'),
      ],
      extra: subject.env,
    })
    const wrap: CommandWrap | undefined =
      options.unsandboxed === true
        ? undefined
        : sandboxWrap(await writeProfile({ runDir: dir, workRoot: options.workRoot }))

    const prepareStart = performance.now()
    for (const step of subject.prepare ?? []) {
      const command = resolvePrepareCommand(step, tree, existsSync)
      const target = wrap === undefined ? { command, args: step.args } : wrap(command, step.args)
      const result = await deps.run(target.command, target.args, {
        cwd: path.join(tree, step.cwd ?? '.'),
        env,
        timeoutMs: PREPARE_TIMEOUT_MS,
        tailChars: 3_000,
      })
      if (result.exitCode !== 0 || result.timedOut) {
        throw new HarnessError(
          'HARNESS_CORPUS_RUN_FAILED',
          `${subject.id} run ${n}: prepare "${step.command} ${step.args.join(' ')}" ${exitText(result)}:\n${tailOf(result, 1500)}`,
        )
      }
    }
    const prepareMs = Math.round(performance.now() - prepareStart)

    const real = await realpath(tree)
    // The runners print real paths, so a root with a symlink in it is known by both names.
    const extraRoots = real === tree ? [] : [real]
    const fired = new Set<string>()
    const outDir = path.join(dir, 'out')
    const result = await run({
      runner: subject.runner,
      cwd: path.join(tree, subject.cwd),
      rootDir: tree,
      extraRoots,
      argv: subject.argv,
      env,
      suite: subject.id,
      outDir,
      timeoutMs: subject.timeoutMs ?? DEFAULT_SUBJECT_TIMEOUT_MS,
      fired,
      ...(wrap === undefined ? {} : { wrap }),
    })

    const sidecar = checkSidecar(result.sidecar ?? '', result.run, tree, extraRoots)
    const meta: RunMeta = {
      repo: repo.id,
      subject: subject.id,
      n,
      startedAt: startedAt.toISOString(),
      runner: subject.runner,
      runnerVersion: result.runnerVersion,
      cloneMs,
      prepareMs,
      runMs: Math.round(result.process.wallMs),
      exitCode: result.exitCode,
      tests: countTests(result.run),
      files: result.run.files.length,
      statuses: statusCounts(result.run),
      fired: [...fired].toSorted(),
      sidecar,
    }
    await writeFile(path.join(dir, 'run.json'), `${JSON.stringify(result.run)}\n`)
    await writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    return meta
  } finally {
    // A failed run leaves no clone (with its node_modules) behind either; a failed cleanup must
    // not replace the run's own error.
    if (options.keepTree !== true)
      await rm(tree, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Reads a finished run's `meta.json`, or `undefined` when the run is not there or not finished.
 * @public
 */
export async function readRunMeta(
  paths: RepoPaths,
  subjectId: string,
  n: number,
): Promise<RunMeta | undefined> {
  const text = await readIfExists(path.join(runDir(paths, subjectId, n), 'meta.json'))
  if (text === undefined) return undefined
  const value: unknown = JSON.parse(text)
  return isRecord(value) && typeof value.subject === 'string' ? asRunMeta(value) : undefined
}

function asRunMeta(value: Record<string, unknown>): RunMeta | undefined {
  const sidecar = value.sidecar
  if (
    typeof value.repo !== 'string' ||
    typeof value.subject !== 'string' ||
    typeof value.n !== 'number' ||
    typeof value.startedAt !== 'string' ||
    typeof value.runner !== 'string' ||
    typeof value.runnerVersion !== 'string' ||
    typeof value.cloneMs !== 'number' ||
    typeof value.prepareMs !== 'number' ||
    typeof value.runMs !== 'number' ||
    typeof value.tests !== 'number' ||
    typeof value.files !== 'number' ||
    !isRecord(value.statuses) ||
    !Array.isArray(value.fired) ||
    !isRecord(sidecar) ||
    typeof sidecar.files !== 'number' ||
    typeof sidecar.withConsole !== 'number' ||
    !Array.isArray(sidecar.missing)
  ) {
    return undefined
  }
  const statuses: Partial<Record<TestStatus, number>> = {}
  for (const [key, count] of Object.entries(value.statuses)) {
    if (typeof count !== 'number') return undefined
    const status = STATUSES.find((candidate) => candidate === key)
    if (status === undefined) return undefined
    statuses[status] = count
  }
  return {
    repo: value.repo,
    subject: value.subject,
    n: value.n,
    startedAt: value.startedAt,
    runner: value.runner,
    runnerVersion: value.runnerVersion,
    cloneMs: value.cloneMs,
    prepareMs: value.prepareMs,
    runMs: value.runMs,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    tests: value.tests,
    files: value.files,
    statuses,
    fired: value.fired.filter((id): id is string => typeof id === 'string'),
    sidecar: {
      files: sidecar.files,
      withConsole: sidecar.withConsole,
      missing: sidecar.missing.filter((file): file is string => typeof file === 'string'),
    },
  }
}

const STATUSES: readonly TestStatus[] = ['passed', 'failed', 'skipped', 'todo', 'notRun']

/**
 * One finished run's `NormalizedRun` file.
 * @public
 */
export function runFile(paths: RepoPaths, subjectId: string, n: number): string {
  return path.join(runDir(paths, subjectId, n), 'run.json')
}

/**
 * Whether a run is already on disk (its `meta.json` is written last).
 * @public
 */
export async function hasRun(paths: RepoPaths, subjectId: string, n: number): Promise<boolean> {
  return existsSync(path.join(runDir(paths, subjectId, n), 'meta.json'))
}

/**
 * The numbers of the finished runs of a subject, ascending.
 * @public
 */
export async function listRuns(paths: RepoPaths, subjectId: string): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(path.join(paths.runs, subjectId))
  } catch (cause) {
    if (isNotFound(cause)) return []
    throw cause
  }
  const numbers = names.filter((name) => /^[1-9]\d*$/.test(name)).map(Number)
  const finished: number[] = []
  for (const n of numbers.toSorted((a, b) => a - b)) {
    if (await hasRun(paths, subjectId, n)) finished.push(n)
  }
  return finished
}
