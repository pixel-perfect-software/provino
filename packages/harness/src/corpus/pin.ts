// `corpus pin`: resolves F5's 7-character SHAs to full commits through GitHub's API (`gh api`, so
// no credential passes through this code), records the commit's date and the tarball's sha256, and
// never re-pins silently: an entry that already has a pin must resolve to the same one.
import { HarnessError } from '../errors.ts'
import { isRecord } from '../internal/guards.ts'
import { type CorpusDeps, defaultDeps } from './deps.ts'
import { ensureTarball } from './fetch.ts'
import { type CorpusSelection, parseCorpusManifest } from './manifest.ts'

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
      `${repo}@${short} did not resolve (ambiguous, unreachable, or gh is not logged in): ${result.output.trim().slice(-300)}`,
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
    !/^[0-9a-f]{40}$/.test(value.sha) ||
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

/** The three fields a pin consists of, as a repository entry holds them. */
interface Pin {
  sha?: unknown
  commitDate?: unknown
  tarballSha256?: unknown
}

/** Pins one entry's fields (on a draft, so a failure leaves the entry as it was). */
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
): Promise<{ readonly pin: Pin; readonly filled: boolean }> {
  if (typeof entry.f5Sha !== 'string') {
    throw new HarnessError('HARNESS_CORPUS_PIN_FAILED', `${id}: no f5Sha to resolve`, {
      path: source,
    })
  }
  const commit = await resolveCommit(repo, entry.f5Sha, options.deps, options.env)
  const pin: Pin = {
    sha: entry.sha,
    commitDate: entry.commitDate,
    tarballSha256: entry.tarballSha256,
  }
  let filled = false
  for (const [key, value] of [
    ['sha', commit.sha],
    ['commitDate', commit.date],
  ] as const) {
    if (pin[key] === undefined) {
      pin[key] = value
      filled = true
    } else if (pin[key] !== value) {
      throw new HarnessError(
        'HARNESS_CORPUS_PIN_FAILED',
        `${id}: the manifest pins ${key} ${String(pin[key])}, GitHub now says ${value}. A pin is never replaced silently`,
        { path: source },
      )
    }
  }
  const expected = typeof pin.tarballSha256 === 'string' ? pin.tarballSha256 : undefined
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
    pin.tarballSha256 = tarball.sha256
    filled = true
  }
  return { pin, filled }
}

/**
 * Pins the selected repositories in the manifest's JSON. Each entry needs `id`, `repo` and
 * `f5Sha`. The `sha`, `commitDate` and `tarballSha256` it already has must equal what the API and
 * the tarball say now (`HARNESS_CORPUS_PIN_FAILED`, `HARNESS_CORPUS_TARBALL_MISMATCH`); the ones it
 * lacks are filled. An id that names no repository (a subject id included) is `HARNESS_USAGE`, before anything is asked of `gh`. A repository that fails stops there for a report and the others go on. With
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
      const { pin, filled } = await pinEntry(entry, id, repo, source, {
        workRoot: options.workRoot,
        deps,
        env,
      })
      entry.sha = pin.sha
      entry.commitDate = pin.commitDate
      entry.tarballSha256 = pin.tarballSha256
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
