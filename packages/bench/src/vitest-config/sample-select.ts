// How B25c's Vitest sample is chosen (D28's terms, Track 11 F4's filters), as pure functions the
// manifest builder applies to what GitHub returns: the most-starred JS/TS repositories, configs in
// fixtures, templates, e2e and `node_modules` left out, at most 6 configs per repository, until
// F4's counts are met: 351 `vitest.config.*` and 68 `vite.config.*` with a `test` block. (F4's six
// legacy `vitest.workspace.*` files are left out: Vitest 5 reads none.)
//
// Choices recorded here: a config is exactly `vitest.config.<ext>` or `vite.config.<ext>` (the
// names Vitest looks for), `ext` one of ts, mts, cts, js, mjs, cjs; a `vite.config.*` counts only
// when its text has a `test` property; within a repository, shallowest first, then by path.

/** A config's kind, as F4 buckets them. */
export type SampleKind = 'vitest.config' | 'vite.config'

/** F4's count per kind. */
export const SAMPLE_QUOTAS: Readonly<Record<SampleKind, number>> = {
  'vitest.config': 351,
  'vite.config': 68,
}

/** F4's cap per repository. */
export const PER_REPO_CAP = 6

const CONFIG_NAME = /^(vitest|vite)\.config\.(?:ts|mts|cts|js|mjs|cjs)$/

/** Whether a path is left out by F4's filters (a segment in fixtures, templates, e2e or node_modules). */
export function isExcludedPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment === 'node_modules' || /fixture|template|e2e/i.test(segment))
}

/** The kind of a candidate path, or `undefined` when it isn't one. */
export function candidateKind(path: string): SampleKind | undefined {
  if (isExcludedPath(path)) return undefined
  const match = CONFIG_NAME.exec(path.slice(path.lastIndexOf('/') + 1))
  return match?.[1] === undefined ? undefined : (`${match[1]}.config` as SampleKind)
}

/** Shallowest first, then by path (code units). */
export function byDepthThenPath(left: string, right: string): number {
  const depth = left.split('/').length - right.split('/').length
  if (depth !== 0) return depth
  return left < right ? -1 : left > right ? 1 : 0
}

/** Whether a `vite.config.*`'s text declares a `test` property (a Vitest project's config). */
export function declaresTest(text: string): boolean {
  return /(^|[\s,{])test\s*:/m.test(text)
}

/** Counts per kind so far. */
export type Tally = Record<SampleKind, number>

/** An empty tally. */
export function emptyTally(): Tally {
  return { 'vitest.config': 0, 'vite.config': 0 }
}

/** Whether every quota is full. */
export function quotasFull(tally: Tally): boolean {
  return (Object.keys(SAMPLE_QUOTAS) as SampleKind[]).every(
    (kind) => tally[kind] >= SAMPLE_QUOTAS[kind],
  )
}

/**
 * The configs one repository contributes: its candidates (sorted), each taken while its kind's
 * quota has room, up to the cap. `isTestConfig` says whether a `vite.config.*` declares `test`.
 * Updates `tally`.
 */
export function takeConfigs(
  candidates: readonly string[],
  isTestConfig: (path: string) => boolean,
  tally: Tally,
): { readonly path: string; readonly kind: SampleKind }[] {
  const taken: { path: string; kind: SampleKind }[] = []
  for (const path of [...candidates].sort(byDepthThenPath)) {
    if (taken.length >= PER_REPO_CAP) break
    const kind = candidateKind(path)
    if (kind === undefined || tally[kind] >= SAMPLE_QUOTAS[kind]) continue
    if (kind === 'vite.config' && !isTestConfig(path)) continue
    taken.push({ path, kind })
    tally[kind]++
  }
  return taken
}
