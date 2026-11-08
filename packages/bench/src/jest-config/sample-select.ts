// How T11.6's sample is chosen (D28; `bundles/B14.md` → question 2), as pure functions the
// manifest builder applies to what GitHub returns. Track 11 F4's rules: the most-starred JS/TS
// repositories, configs in fixtures, templates, e2e and `node_modules` left out, at most 6 configs
// per repository, until there are 299 sources with F4's count per format (179 `.js`, 44
// `package.json#jest`, 28 `.ts`, 17 `.json`, 14 `.mjs`, 11 `.cjs`, 6 `.cts`).
//
// Choices the brief leaves open, recorded here and in the manifest:
// - A config is `jest.config.<ext>` or a variant named like one (`jest.config.base.js`,
//   `jest.unit.config.ts`), or a `package.json` whose `jest` key is an object. A string `jest` key
//   points at another file, so it isn't a source of its own.
// - A format whose quota is full takes no more configs, so the sample has exactly F4's mix; `.mts`
//   (none in F4) takes none.
// - Within a repository, configs are taken shallowest first, then by path.

/** A config's format, as F4 buckets them. */
export type SampleFormat =
  | '.js'
  | '.ts'
  | '.mjs'
  | '.mts'
  | '.cjs'
  | '.cts'
  | '.json'
  | 'package.json'

/** F4's count per format. */
export const SAMPLE_QUOTAS: Readonly<Record<SampleFormat, number>> = {
  '.js': 179,
  'package.json': 44,
  '.ts': 28,
  '.json': 17,
  '.mjs': 14,
  '.cjs': 11,
  '.cts': 6,
  '.mts': 0,
}

/** F4's total. */
export const SAMPLE_TOTAL = 299

/** F4's cap per repository. */
export const PER_REPO_CAP = 6

const CONFIG_NAME =
  /^jest(?:\.[\w-]+)*\.config(?:\.[\w-]+)*\.(js|ts|mjs|mts|cjs|cts|json)$|^jest\.config\.(js|ts|mjs|mts|cjs|cts|json)$/

/** Whether a path is left out by F4's filters (a segment in fixtures, templates, e2e or node_modules). */
export function isExcludedPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment === 'node_modules' || /fixture|template|e2e/i.test(segment))
}

/** The format of a candidate path, or `undefined` when it isn't one. */
export function candidateFormat(path: string): SampleFormat | undefined {
  if (isExcludedPath(path)) return undefined
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name === 'package.json') return 'package.json'
  const match = CONFIG_NAME.exec(name)
  const ext = match?.[1] ?? match?.[2]
  return ext === undefined ? undefined : (`.${ext}` as SampleFormat)
}

/** Shallowest first, then by path (code units). */
export function byDepthThenPath(left: string, right: string): number {
  const depth = left.split('/').length - right.split('/').length
  if (depth !== 0) return depth
  return left < right ? -1 : left > right ? 1 : 0
}

/** Whether a package.json's text has a `jest` key holding an object (a config of its own). */
export function hasJestObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return false
    const jest: unknown = Reflect.get(parsed, 'jest')
    return typeof jest === 'object' && jest !== null && !Array.isArray(jest)
  } catch {
    return false
  }
}

/** Counts per format so far. */
export type Tally = Record<SampleFormat, number>

/** An empty tally. */
export function emptyTally(): Tally {
  return {
    '.js': 0,
    '.ts': 0,
    '.mjs': 0,
    '.mts': 0,
    '.cjs': 0,
    '.cts': 0,
    '.json': 0,
    'package.json': 0,
  }
}

/** Whether every quota is full. */
export function quotasFull(tally: Tally): boolean {
  return (Object.keys(SAMPLE_QUOTAS) as SampleFormat[]).every(
    (format) => tally[format] >= SAMPLE_QUOTAS[format],
  )
}

/**
 * The configs one repository contributes, in order: its candidates (sorted), each taken while its
 * format's quota has room, up to the cap. `isConfig` says whether a `package.json` has a `jest`
 * object. Updates `tally`.
 */
export function takeConfigs(
  candidates: readonly string[],
  isConfig: (path: string) => boolean,
  tally: Tally,
): { readonly path: string; readonly format: SampleFormat }[] {
  const taken: { path: string; format: SampleFormat }[] = []
  for (const path of [...candidates].sort(byDepthThenPath)) {
    if (taken.length >= PER_REPO_CAP) break
    const format = candidateFormat(path)
    if (format === undefined || tally[format] >= SAMPLE_QUOTAS[format]) continue
    if (format === 'package.json' && !isConfig(path)) continue
    taken.push({ path, format })
    tally[format]++
  }
  return taken
}
