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

/** Counts per kind (a format, for Jest) so far. */
export type KindTally<K extends string> = Record<K, number>

/** An empty tally for the kinds `quotas` names. */
export function emptyTallyFor<K extends string>(quotas: Readonly<Record<K, number>>): KindTally<K> {
  return Object.fromEntries(Object.keys(quotas).map((kind) => [kind, 0])) as KindTally<K>
}

/** Whether every quota is full. */
export function quotasFullFor<K extends string>(
  tally: KindTally<K>,
  quotas: Readonly<Record<K, number>>,
): boolean {
  return (Object.keys(quotas) as K[]).every((kind) => tally[kind] >= quotas[kind])
}

/**
 * The configs one repository contributes, in order: its candidates (sorted), each taken while its
 * kind's quota has room, up to the cap. `needsText` names the kind whose configs count only when
 * `isConfig` says so (a `package.json` with a `jest` object, a `vite.config.*` with `test`).
 * Updates `tally`.
 */
export function takeConfigsBy<K extends string>(
  candidates: readonly string[],
  classify: (path: string) => K | undefined,
  needsText: K,
  isConfig: (path: string) => boolean,
  tally: KindTally<K>,
  quotas: Readonly<Record<K, number>>,
): { readonly path: string; readonly kind: K }[] {
  const taken: { path: string; kind: K }[] = []
  for (const path of [...candidates].sort(byDepthThenPath)) {
    if (taken.length >= PER_REPO_CAP) break
    const kind = classify(path)
    if (kind === undefined || tally[kind] >= quotas[kind]) continue
    if (kind === needsText && !isConfig(path)) continue
    taken.push({ path, kind })
    tally[kind]++
  }
  return taken
}

/** Counts per format so far. */
export type Tally = KindTally<SampleFormat>

/** An empty tally. */
export function emptyTally(): Tally {
  return emptyTallyFor(SAMPLE_QUOTAS)
}

/** Whether every quota is full. */
export function quotasFull(tally: Tally): boolean {
  return quotasFullFor(tally, SAMPLE_QUOTAS)
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
  return takeConfigsBy(
    candidates,
    candidateFormat,
    'package.json',
    isConfig,
    tally,
    SAMPLE_QUOTAS,
  ).map(({ path, kind }) => ({ path, format: kind }))
}
