// T12.9's fetcher: a repository's tarball from `codeload.github.com` at its pinned commit, checked
// against the manifest's sha256, optionally extracted with the system `tar`. It never clones
// (the sandbox blocks a nested clone, B05) and never installs or runs anything.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import { isNotFound } from '../internal/guards.ts'
import { type CorpusDeps, defaultDeps } from './deps.ts'
import { isLeftOut, LEFT_OUT_PATTERNS } from './left-out.ts'
import type { CorpusRepo } from './manifest.ts'
import { type RepoPaths, repoPaths } from './paths.ts'

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const TAR_TIMEOUT_MS = 10 * 60_000

/**
 * The URL of a repository's tarball at its pinned commit.
 * @public
 */
export function tarballUrl(repo: Pick<CorpusRepo, 'repo' | 'sha'>): string {
  return `https://codeload.github.com/${repo.repo}/tar.gz/${repo.sha}`
}

/**
 * The sha256 of a file, read as a stream.
 * @public
 */
export async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Downloads the tarball to `dest` through a temporary name, so a partial file never stays. */
async function download(
  url: string,
  dest: string,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  await rm(partial, { force: true })
  const result = await deps.run(
    'curl',
    ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', partial, url],
    { cwd: path.dirname(dest), env, timeoutMs: DOWNLOAD_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    await rm(partial, { force: true })
    throw new HarnessError(
      'HARNESS_CORPUS_FETCH_FAILED',
      `curl exited ${result.exitCode ?? result.signal} for ${url}: ${result.output.trim().slice(-300)}`,
      { path: dest },
    )
  }
  await rename(partial, dest)
}

/**
 * Makes sure a repository's tarball is on disk and says its sha256. A file already there is reused
 * when no `expectedSha256` is given or it matches; otherwise the tarball is downloaded again. When
 * `expectedSha256` is given and the download differs, that is `HARNESS_CORPUS_TARBALL_MISMATCH`:
 * the pin is never replaced silently.
 * @public
 */
export async function ensureTarball(
  repo: Pick<CorpusRepo, 'id' | 'repo' | 'sha'>,
  options: {
    readonly workRoot: string
    readonly expectedSha256?: string
    readonly deps?: CorpusDeps
    readonly env?: NodeJS.ProcessEnv
  },
): Promise<{ readonly path: string; readonly sha256: string; readonly downloaded: boolean }> {
  const deps = options.deps ?? defaultDeps
  const env = options.env ?? process.env
  const file = repoPaths(options.workRoot, repo).tarball
  let present: string | undefined
  try {
    present = await sha256OfFile(file)
  } catch (cause) {
    if (!isNotFound(cause)) throw cause
  }
  if (
    present !== undefined &&
    (options.expectedSha256 === undefined || present === options.expectedSha256)
  ) {
    return { path: file, sha256: present, downloaded: false }
  }
  await download(tarballUrl(repo), file, deps, env)
  const sha256 = await sha256OfFile(file)
  if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
    throw new HarnessError(
      'HARNESS_CORPUS_TARBALL_MISMATCH',
      `${repo.id}: ${tarballUrl(repo)} has sha256 ${sha256}, the manifest pins ${options.expectedSha256}`,
      { path: file },
    )
  }
  return { path: file, sha256, downloaded: true }
}

/** The tarball's entry names with the leading `<repo>-<sha>/` directory removed. */
async function listTarball(
  tarball: string,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<Set<string>> {
  const result = await deps.run('tar', ['-tzf', tarball], {
    cwd: path.dirname(tarball),
    env,
    timeoutMs: TAR_TIMEOUT_MS,
    keepStreams: true,
    tailChars: 2_000,
  })
  if (result.exitCode !== 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_FETCH_FAILED',
      `tar could not list ${tarball}: ${result.output.trim().slice(-300)}`,
      { path: tarball },
    )
  }
  const entries = new Set<string>()
  for (const line of (result.streams?.stdout ?? '').split('\n')) {
    const slash = line.indexOf('/')
    if (slash < 0) continue
    const name = line.slice(slash + 1).replace(/\/$/, '')
    if (name !== '') entries.add(name)
  }
  return entries
}

const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:\.[a-z]+)?$/i
const MIT_TEXT = /\bMIT\b|Permission is hereby granted, free of charge/

/**
 * The problems with a tarball's entries against what the manifest says it holds: the lockfile,
 * and for each subject its directory and runner config files.
 * @public
 */
export function verifyEntries(repo: CorpusRepo, entries: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (repo.install.lockfile !== undefined && !entries.has(repo.install.lockfile)) {
    problems.push(`no lockfile ${repo.install.lockfile}`)
  }
  for (const subject of repo.subjects) {
    // A subject's directory needs to exist; some (nx's tools/eslint-rules) have no package.json.
    const prefix = `${subject.cwd}/`
    if (subject.cwd !== '.' && ![...entries].some((name) => name.startsWith(prefix))) {
      problems.push(`subject ${subject.id}: no directory ${subject.cwd}`)
    }
    for (const config of subject.config) {
      if (!entries.has(config)) problems.push(`subject ${subject.id}: no runner config ${config}`)
    }
  }
  return problems
}

/** The licence file's name at the root of the tarball, if there is one. */
function licenceEntry(entries: ReadonlySet<string>): string | undefined {
  // The root's; a repository that keeps its licence per package (date-fns: pkgs/core/LICENSE.md)
  // has the first one by path.
  const root = [...entries].find((name) => !name.includes('/') && LICENCE_FILE.test(name))
  if (root !== undefined) return root
  return [...entries]
    .filter(
      (name) => name.split('/').length <= 3 && LICENCE_FILE.test(name.split('/').at(-1) ?? ''),
    )
    .toSorted()[0]
}

async function readEntry(
  tarball: string,
  entry: string,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // The first component is `<repo>-<sha>`; a pattern with a leading `*/` finds the entry in it.
  const result = await deps.run('tar', ['-xzOf', tarball, '--include', `*/${entry}`], {
    cwd: path.dirname(tarball),
    env,
    timeoutMs: TAR_TIMEOUT_MS,
    keepStreams: true,
    tailChars: 2_000,
  })
  if (result.exitCode !== 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_FETCH_FAILED',
      `tar could not read ${entry} from ${tarball}`,
      { path: tarball },
    )
  }
  return result.streams?.stdout ?? ''
}

/**
 * How one repository's fetch went.
 * @public
 */
export interface FetchResult {
  readonly id: string
  readonly tarball: string
  readonly sha256: string
  /** Whether the tarball was downloaded now (false: the file on disk already matched). */
  readonly downloaded: boolean
  readonly entries: number
  /** The extracted tree; absent with `verifyOnly`, or when there are problems. */
  readonly src?: string
  /** What the tarball lacks that the manifest says it has. Empty when the pin is real. */
  readonly problems: readonly string[]
  /** Entries the extractor leaves out (`isLeftOut`), as repository paths. */
  readonly leftOut: readonly string[]
}

/**
 * What `fetchRepo` is asked.
 * @public
 */
export interface FetchOptions {
  /** `.refs/corpus/` or another work directory. */
  readonly workRoot: string
  /** Check the tarball and its contents; extract nothing. */
  readonly verifyOnly?: boolean
  readonly deps?: CorpusDeps
  readonly env?: NodeJS.ProcessEnv
}

async function extract(
  repo: CorpusRepo,
  paths: RepoPaths,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let marker: string | undefined
  try {
    marker = (await readFile(paths.srcMarker, 'utf8')).trim()
  } catch (cause) {
    if (!isNotFound(cause)) throw cause
  }
  if (marker === repo.sha) return
  // Another commit's tree (or a half-extracted one) goes before the new one comes in.
  await rm(paths.src, { recursive: true, force: true })
  await rm(paths.srcMarker, { force: true })
  await mkdir(paths.src, { recursive: true })
  const result = await deps.run(
    'tar',
    [
      '-xzf',
      paths.tarball,
      '-C',
      paths.src,
      '--strip-components=1',
      ...LEFT_OUT_PATTERNS.flatMap((pattern) => ['--exclude', pattern]),
    ],
    { cwd: paths.dir, env, timeoutMs: TAR_TIMEOUT_MS },
  )
  if (result.exitCode !== 0) {
    // A failed cleanup must not replace the extraction's own error.
    await rm(paths.src, { recursive: true, force: true }).catch(() => undefined)
    throw new HarnessError(
      'HARNESS_CORPUS_FETCH_FAILED',
      `tar could not extract ${paths.tarball}: ${result.output.trim().slice(-300)}`,
      { path: paths.tarball },
    )
  }
  await writeFile(paths.srcMarker, `${repo.sha}\n`)
}

/**
 * Fetches one repository at its pinned commit: the tarball into `<work>/<id>/<sha>.tar.gz` (kept,
 * and reused when its sha256 already matches), then its entries are checked against the manifest:
 * the lockfile, each subject's directory and runner config, and an MIT licence file. Without
 * `verifyOnly` it is extracted with `tar --strip-components=1` into `<work>/<id>/src`, unless that
 * tree already came from this commit. A sha256 that differs from the manifest's is
 * `HARNESS_CORPUS_TARBALL_MISMATCH`: the pin is never replaced silently.
 * @public
 */
export async function fetchRepo(repo: CorpusRepo, options: FetchOptions): Promise<FetchResult> {
  const deps = options.deps ?? defaultDeps
  const env = options.env ?? process.env
  const paths = repoPaths(options.workRoot, repo)
  const { sha256, downloaded } = await ensureTarball(repo, {
    workRoot: options.workRoot,
    expectedSha256: repo.tarballSha256,
    deps,
    env,
  })
  const entries = await listTarball(paths.tarball, deps, env)
  const problems = verifyEntries(repo, entries)
  const licence = licenceEntry(entries)
  if (licence === undefined) {
    problems.push('no licence file at the root')
  } else if (!MIT_TEXT.test(await readEntry(paths.tarball, licence, deps, env))) {
    problems.push(`${licence} does not read as the MIT licence`)
  }
  const base = {
    id: repo.id,
    tarball: paths.tarball,
    sha256,
    downloaded,
    entries: entries.size,
    problems,
    leftOut: [...entries].filter(isLeftOut).toSorted(),
  }
  if (options.verifyOnly === true || problems.length > 0) return base
  await extract(repo, paths, deps, env)
  return { ...base, src: paths.src }
}

/**
 * `du -sk` of a directory in megabytes, or `undefined` if it can't be measured.
 * @public
 */
export async function diskUsageMb(
  dir: string,
  deps: CorpusDeps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | undefined> {
  try {
    const result = await deps.run('du', ['-sk', dir], {
      cwd: dir,
      env,
      timeoutMs: 10 * 60_000,
      keepStreams: true,
    })
    const kilobytes = Number((result.streams?.stdout ?? '').split(/\s+/)[0])
    return Number.isFinite(kilobytes) ? Math.round(kilobytes / 1024) : undefined
  } catch {
    return undefined
  }
}
