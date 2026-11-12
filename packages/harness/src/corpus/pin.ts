// `corpus pin`: resolves F5's 7-character SHAs to full commits through GitHub's API (`gh api`, so
// no credential passes through this code), records the commit's date and the tarball's sha256, and
// never re-pins silently: an entry that already has a pin must resolve to the same one.
import { HarnessError } from '../errors.ts'
import { isRecord } from '../internal/guards.ts'
import { type CorpusDeps, defaultDeps, tailOf } from './deps.ts'
import { ensureTarball, indexTarball, readEntry } from './fetch.ts'
import { type CorpusSelection, parseCorpusManifest, SHA40 } from './manifest.ts'

/**
 * What GitHub says a short SHA is.
 * @public
 */
export interface ResolvedCommit {
  readonly sha: string
  /** The committer date, `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly date: string
}

/**
 * Resolves a short SHA with `gh api repos/<repo>/commits/<short>`. A SHA that is ambiguous or no
 * longer reachable (a force-pushed branch, a deleted fork) is `HARNESS_CORPUS_PIN_FAILED`: the
 * repository stops for a report.
 * @public
 */
export async function resolveCommit(
  repo: string,
  short: string,
  deps: CorpusDeps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCommit> {
  const result = await deps.run(
    'gh',
    ['api', `repos/${repo}/commits/${short}`, '--jq', '{sha: .sha, date: .commit.committer.date}'],
    { cwd: process.cwd(), env, timeoutMs: 60_000, keepStreams: true },
  )
  if (result.exitCode !== 0) {
    throw new HarnessError(
      'HARNESS_CORPUS_PIN_FAILED',
      `${repo}@${short} did not resolve (ambiguous, unreachable, or gh is not logged in): ${tailOf(result, 300)}`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(result.streams?.stdout ?? '')
  } catch (cause) {
    throw new HarnessError('HARNESS_CORPUS_PIN_FAILED', `${repo}@${short}: gh printed no JSON`, {
      cause,
    })
  }
  if (
    !isRecord(value) ||
    typeof value.sha !== 'string' ||
    !SHA40.test(value.sha) ||
    typeof value.date !== 'string'
  ) {
    throw new HarnessError('HARNESS_CORPUS_PIN_FAILED', `${repo}@${short}: unexpected API answer`)
  }
  if (!value.sha.startsWith(short)) {
    throw new HarnessError(
      'HARNESS_CORPUS_PIN_FAILED',
      `${repo}@${short} resolved to ${value.sha}, which does not start with it`,
    )
  }
  return { sha: value.sha, date: value.date }
}

/**
 * What a pin run did to one repository.
 * @public
 */
export interface PinChange {
  readonly id: string
  /** `new`: some of the pin was filled in; `same`: it was complete and the API agrees. */
  readonly outcome: 'new' | 'same'
}

/**
 * A repository a pin run stopped on: an ambiguous or unreachable SHA, or a pin that moved.
 * @public
 */
export interface PinFailure {
  readonly id: string
  readonly error: HarnessError
}

/** The pnpm lockfile format marker (`lockfileVersion`) to a pnpm version that writes and reads it. */
const PNPM_FOR_LOCKFILE: Readonly<Record<string, string>> = {
  '5.3': '6.35.1',
  '5.4': '7.33.7',
  '6.0': '8.15.9',
  // 9.0 is written by pnpm 9 through 12, and the newest reads the older: the newest the corpus pins.
  '9.0': '12.16.0',
}

/** npm's `lockfileVersion` to the npm that writes it (3 is read by npm 9 and later: Node 24's). */
const NPM_FOR_LOCKFILE: Readonly<Record<string, string>> = {
  '1': '6.14.18',
  '2': '8.19.4',
  '3': '11.19.1',
}

/** Yarn Berry's `__metadata.version` to the last Yarn that writes it. */
const YARN_FOR_METADATA: Readonly<Record<string, string>> = {
  '4': '2.4.3',
  '6': '3.8.7',
  '8': '4.18.1',
}

/** Yarn classic's last release. */
const YARN_CLASSIC = '1.22.22'

/**
 * The package manager's exact version for a repository that pins none in the manifest: the root
 * `package.json`'s `packageManager` field when it names this manager (`nub@0.8.3` does not name
 * pnpm), else the version its lockfile's format marker implies. Neither is `HARNESS_CORPUS_PIN_FAILED`:
 * a person writes the version, and says why in the repository's note.
 * @public
 */
export function inferManagerVersion(
  name: string,
  packageJson: string | undefined,
  lockfile: string | undefined,
): { readonly version: string; readonly from: 'packageManager' | 'lockfile' } {
  let manifest: unknown
  try {
    manifest = packageJson === undefined ? undefined : JSON.parse(packageJson)
  } catch {
    manifest = undefined
  }
  const field = isRecord(manifest) ? manifest.packageManager : undefined
  const named = typeof field === 'string' ? /^([a-z]+)@(\d+\.\d+\.\d+)(?:\+.+)?$/.exec(field) : null
  if (named?.[1] === name && named[2] !== undefined) {
    return { version: named[2], from: 'packageManager' }
  }
  const marker = lockfile === undefined ? undefined : lockfileMarker(name, lockfile)
  if (marker !== undefined) return { version: marker, from: 'lockfile' }
  throw new HarnessError(
    'HARNESS_CORPUS_PIN_FAILED',
    `no ${name} version to infer: the root package.json has no packageManager for it and the lockfile's format marker is missing or unknown; set install.version by hand and say why in the repository's note`,
  )
}

function lockfileMarker(name: string, lockfile: string): string | undefined {
  if (name === 'pnpm')
    return PNPM_FOR_LOCKFILE[/^lockfileVersion:\s*'?([\d.]+)'?/m.exec(lockfile)?.[1] ?? '']
  if (name === 'npm')
    return NPM_FOR_LOCKFILE[/"lockfileVersion":\s*(\d+)/.exec(lockfile)?.[1] ?? '']
  if (/^# yarn lockfile v1$/m.test(lockfile)) return YARN_CLASSIC
  return YARN_FOR_METADATA[/^__metadata:\s*\n\s+version:\s*(\d+)/m.exec(lockfile)?.[1] ?? '']
}

/** Pins one entry's fields in place; whether any was filled in. */
async function pinEntry(
  entry: Record<string, unknown>,
  id: string,
  repo: string,
  source: string,
  options: {
    readonly workRoot: string
    readonly deps: CorpusDeps
    readonly env: NodeJS.ProcessEnv
  },
): Promise<boolean> {
  if (typeof entry.f5Sha !== 'string') {
    throw new HarnessError('HARNESS_CORPUS_PIN_FAILED', `${id}: no f5Sha to resolve`, {
      path: source,
    })
  }
  const commit = await resolveCommit(repo, entry.f5Sha, options.deps, options.env)
  let filled = false
  for (const [key, value] of [
    ['sha', commit.sha],
    ['commitDate', commit.date],
  ] as const) {
    if (entry[key] === undefined) {
      entry[key] = value
      filled = true
    } else if (entry[key] !== value) {
      throw new HarnessError(
        'HARNESS_CORPUS_PIN_FAILED',
        `${id}: the manifest pins ${key} ${String(entry[key])}, GitHub now says ${value}. A pin is never replaced silently`,
        { path: source },
      )
    }
  }
  const expected = typeof entry.tarballSha256 === 'string' ? entry.tarballSha256 : undefined
  const tarball = await ensureTarball(
    { id, repo, sha: commit.sha },
    {
      workRoot: options.workRoot,
      ...(expected === undefined ? {} : { expectedSha256: expected }),
      deps: options.deps,
      env: options.env,
    },
  )
  if (expected === undefined) {
    entry.tarballSha256 = tarball.sha256
    filled = true
  }
  const install = entry.install
  if (isRecord(install) && typeof install.name === 'string' && install.version === undefined) {
    const version = await managerVersion(install, tarball, options)
    // `version` goes right after `name`, as the manifest writes it.
    entry.install = { name: install.name, version, ...install }
    filled = true
  }
  return filled
}

/** The version of the package manager a repository's `install` names, read from its tarball. */
async function managerVersion(
  install: Record<string, unknown>,
  tarball: { readonly path: string; readonly sha256: string },
  options: { readonly deps: CorpusDeps; readonly env: NodeJS.ProcessEnv },
): Promise<string> {
  const { top, entries } = await indexTarball(
    tarball.path,
    tarball.sha256,
    options.deps,
    options.env,
  )
  const read = async (file: unknown): Promise<string | undefined> =>
    typeof file === 'string' && entries.has(file)
      ? readEntry(tarball.path, top, file, options.deps, options.env)
      : undefined
  return inferManagerVersion(
    String(install.name),
    await read('package.json'),
    await read(install.lockfile),
  ).version
}

/**
 * Pins the selected repositories in the manifest's JSON. Each entry needs `id`, `repo` and
 * `f5Sha`. The `sha`, `commitDate` and `tarballSha256` it already has must equal what the API and
 * the tarball say now (`HARNESS_CORPUS_PIN_FAILED`, `HARNESS_CORPUS_TARBALL_MISMATCH`); the ones it
 * lacks are filled, and so is `install.version` when absent (`inferManagerVersion`). An id that names no repository (a subject id included) is `HARNESS_USAGE`, before anything is asked of `gh`. A repository that fails stops there for a report and the others go on. With
 * no failure the whole result is parsed strictly and returned as the new text; with one the text is
 * returned unchanged, so a half-pinned manifest is never written.
 * @public
 */
export async function pinManifest(
  text: string,
  source: string,
  options: {
    readonly selection: CorpusSelection
    readonly workRoot: string
    readonly deps?: CorpusDeps
    readonly env?: NodeJS.ProcessEnv
    readonly onChange?: (change: PinChange) => void
  },
): Promise<{
  readonly text: string
  readonly changes: readonly PinChange[]
  readonly failures: readonly PinFailure[]
}> {
  const deps = options.deps ?? defaultDeps
  const env = options.env ?? process.env
  const root: unknown = JSON.parse(text)
  if (!isRecord(root) || !Array.isArray(root.repos)) {
    throw new HarnessError('HARNESS_CORPUS_MANIFEST_INVALID', `${source}: no "repos" array`, {
      path: source,
    })
  }
  const { selection } = options
  const entries: { entry: Record<string, unknown>; id: string; repo: string }[] = []
  for (const entry of root.repos) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.repo !== 'string') {
      throw new HarnessError(
        'HARNESS_CORPUS_MANIFEST_INVALID',
        `${source}: a repository has no id or repo`,
        { path: source },
      )
    }
    entries.push({ entry, id: entry.id, repo: entry.repo })
  }
  if (selection.kind === 'ids') {
    // As `selectRepos` does, but only a repository can be pinned: its subjects share its pin.
    const known = new Set(entries.map(({ id }) => id))
    for (const id of selection.ids) {
      if (!known.has(id)) {
        throw new HarnessError(
          'HARNESS_USAGE',
          `no corpus repository "${id}" to pin (a subject id is not one: name its repository)`,
        )
      }
    }
  }
  const changes: PinChange[] = []
  const failures: PinFailure[] = []
  for (const { entry, id, repo } of entries) {
    const wanted =
      selection.kind === 'all' ||
      (selection.kind === 'pilot' && entry.pilot === true) ||
      (selection.kind === 'ids' && selection.ids.includes(id))
    if (!wanted) continue
    try {
      const filled = await pinEntry(entry, id, repo, source, {
        workRoot: options.workRoot,
        deps,
        env,
      })
      const change: PinChange = { id, outcome: filled ? 'new' : 'same' }
      changes.push(change)
      options.onChange?.(change)
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error
      failures.push({ id, error })
    }
  }
  if (failures.length > 0) return { text, changes, failures }
  const out = `${JSON.stringify(root, null, 2)}\n`
  parseCorpusManifest(out, source)
  return { text: out, changes, failures }
}
