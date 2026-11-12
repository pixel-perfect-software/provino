// T12.9's fetcher: a repository's tarball from `codeload.github.com` at its pinned commit, checked
// against the manifest's sha256, optionally extracted with the system `tar`. It never clones
// (the sandbox blocks a nested clone, B05) and never installs or runs anything.
import { createHash, hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '../errors.ts'
import { isNotFound, isRecord, readIfExists } from '../internal/guards.ts'
import { type CorpusDeps, defaultDeps, exitText, tailOf } from './deps.ts'
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

/** Files up to this size are read whole and hashed in one call: far fewer awaits than a stream. */
const SMALL_FILE_BYTES = 4 * 1024 * 1024

/**
 * A file's size and sha256: read whole when it is at most `smallBytes`, else streamed.
 * @internal
 */
export async function digestFile(
  file: string,
  smallBytes: number = SMALL_FILE_BYTES,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const { size } = await stat(file)
  if (size <= smallBytes) {
    const bytes = await readFile(file)
    return { size: bytes.length, sha256: hash('sha256', bytes) }
  }
  const streamed = createHash('sha256')
  for await (const chunk of createReadStream(file)) streamed.update(chunk as Buffer)
  return { size, sha256: streamed.digest('hex') }
}

/**
 * The sha256 of a file.
 * @public
 */
export async function sha256OfFile(file: string): Promise<string> {
  return (await digestFile(file)).sha256
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
      `curl ${exitText(result)} for ${url}: ${tailOf(result, 300)}`,
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

/**
 * The tarball's entry names with the leading `<repo>-<sha>/` directory removed, and that
 * directory's name (`top`), which `readEntry` needs to name a member exactly.
 */
async function listTarball(
  tarball: string,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly entries: Set<string>; readonly top: string }> {
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
      `tar could not list ${tarball}: ${tailOf(result, 300)}`,
      { path: tarball },
    )
  }
  const entries = new Set<string>()
  let top = ''
  for (const line of (result.streams?.stdout ?? '').split('\n')) {
    const slash = line.indexOf('/')
    if (slash < 0) continue
    if (top === '') top = line.slice(0, slash)
    const name = line.slice(slash + 1).replace(/\/$/, '')
    if (name !== '') entries.add(name)
  }
  return { entries, top }
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

/**
 * One member's text, by its exact name under the top directory.
 * @internal
 */
export async function readEntry(
  tarball: string,
  top: string,
  entry: string,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // One member by its exact name (`<repo>-<sha>/<entry>`). `--include` is bsdtar's alone, and its
  // `*` crosses `/`, so a pattern could also read a nested file of the same name.
  const result = await deps.run('tar', ['-xzOf', tarball, `${top}/${entry}`], {
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
 * What a pass over a tarball finds, which is a function of its bytes alone: the entry names, the
 * top directory and the licence file's verdict. `fetchRepo` checks the manifest against it.
 * @internal
 */
export interface TarballIndex {
  readonly top: string
  readonly entries: ReadonlySet<string>
  /** The licence file's name, if the tarball has one, and whether it reads as MIT. */
  readonly licence: { readonly entry: string | undefined; readonly mit: boolean }
}

/** Where a tarball's index is remembered, keyed inside by the tarball's sha256. */
function indexFile(tarball: string): string {
  return `${tarball}.index.json`
}

function parseIndex(text: string, sha256: string): TarballIndex | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (
    !isRecord(value) ||
    value.sha256 !== sha256 ||
    typeof value.top !== 'string' ||
    !Array.isArray(value.entries) ||
    !value.entries.every((entry): entry is string => typeof entry === 'string') ||
    !isRecord(value.licence) ||
    typeof value.licence.mit !== 'boolean' ||
    (value.licence.entry !== undefined && typeof value.licence.entry !== 'string')
  ) {
    return undefined
  }
  return {
    top: value.top,
    entries: new Set(value.entries),
    licence: { entry: value.licence.entry, mit: value.licence.mit },
  }
}

/**
 * The tarball's index: read from the file next to it when that was written for this sha256,
 * else made with one list pass and one read of the licence, and written. A different tarball has
 * a different sha256, so it is checked afresh.
 * @internal
 */
export async function indexTarball(
  tarball: string,
  sha256: string,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<TarballIndex> {
  const remembered = await readIfExists(indexFile(tarball))
  const known = remembered === undefined ? undefined : parseIndex(remembered, sha256)
  if (known !== undefined) return known
  const { entries, top } = await listTarball(tarball, deps, env)
  const entry = licenceEntry(entries)
  const mit = entry !== undefined && MIT_TEXT.test(await readEntry(tarball, top, entry, deps, env))
  const index: TarballIndex = { top, entries, licence: { entry, mit } }
  await writeFile(
    indexFile(tarball),
    `${JSON.stringify({ sha256, top, entries: [...entries], licence: { ...(entry === undefined ? {} : { entry }), mit } })}\n`,
  )
  return index
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

/**
 * The commit the extracted tree came from (`src.sha`), or `undefined` when there is no marker.
 * @internal
 */
export async function readSrcMarker(
  paths: Pick<RepoPaths, 'srcMarker'>,
): Promise<string | undefined> {
  return (await readIfExists(paths.srcMarker))?.trim()
}

async function extract(
  repo: CorpusRepo,
  paths: RepoPaths,
  deps: CorpusDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if ((await readSrcMarker(paths)) === repo.sha) return
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
      `tar could not extract ${paths.tarball}: ${tailOf(result, 300)}`,
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
  const { entries, licence } = await indexTarball(paths.tarball, sha256, deps, env)
  const problems = verifyEntries(repo, entries)
  if (licence.entry === undefined) {
    problems.push('no licence file at the root')
  } else if (!licence.mit) {
    problems.push(`${licence.entry} does not read as the MIT licence`)
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
