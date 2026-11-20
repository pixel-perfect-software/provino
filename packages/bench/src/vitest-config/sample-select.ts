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

import {
  byDepthThenPath,
  emptyTallyFor,
  isExcludedPath,
  type KindTally,
  PER_REPO_CAP,
  quotasFullFor,
  takeConfigsBy,
} from '../jest-config/sample-select.ts'

export { byDepthThenPath, isExcludedPath, PER_REPO_CAP }

const CONFIG_NAME = /^(vitest|vite)\.config\.(?:ts|mts|cts|js|mjs|cjs)$/

/** The kind of a candidate path, or `undefined` when it isn't one. */
export function candidateKind(path: string): SampleKind | undefined {
  if (isExcludedPath(path)) return undefined
  const match = CONFIG_NAME.exec(path.slice(path.lastIndexOf('/') + 1))
  return match?.[1] === undefined ? undefined : (`${match[1]}.config` as SampleKind)
}

/** Whether a `vite.config.*`'s text declares a `test` property (a Vitest project's config). */
export function declaresTest(text: string): boolean {
  return /(^|[\s,{])test\s*:/m.test(text)
}

/** Counts per kind so far. */
export type Tally = KindTally<SampleKind>

/** An empty tally. */
export function emptyTally(): Tally {
  return emptyTallyFor(SAMPLE_QUOTAS)
}

/** Whether every quota is full. */
export function quotasFull(tally: Tally): boolean {
  return quotasFullFor(tally, SAMPLE_QUOTAS)
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
  return takeConfigsBy(candidates, candidateKind, 'vite.config', isTestConfig, tally, SAMPLE_QUOTAS)
}
