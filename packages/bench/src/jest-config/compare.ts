// What the Jest config oracle checks compare, and how (`bundles/B14.md` → gaps 4 and 5). Both
// sides' `readConfig` results are encoded the same way (functions as their source, `RegExp` as
// source and flags, `undefined` kept), then compared key by key.
//
// - The bar is the 55 keys Track 11 F4 found in ≥2% of repos (T11.6 says "40"; F4's table has 55):
//   46 in the project config, 8 in the global config, and `preset`, which is in neither and is
//   checked through what it puts in the others.
// - Gap 5's one rule: `babel-jest`, `jest-environment-node`, `jest-circus` and `jest-runner`
//   resolve from wherever a Jest install has them, so a path into one of those packages compares
//   as its package-relative form (`babel-jest/build/index.js`) on both sides. Every other path
//   compares exactly.
// - Every other key is compared too and reported beside the bar, not as it (`seed` is random and
//   left out; `@jest/test-sequencer` gets the same package-relative rule there).

/** The project-config keys of the bar (F4, ≥2% of repos). */
export const PROJECT_BAR_KEYS: readonly string[] = [
  'testEnvironment',
  'transform',
  'setupFilesAfterEnv',
  'moduleNameMapper',
  'testPathIgnorePatterns',
  'transformIgnorePatterns',
  'testMatch',
  'setupFiles',
  'modulePathIgnorePatterns',
  'collectCoverageFrom',
  'moduleFileExtensions',
  'rootDir',
  'roots',
  'testTimeout',
  'coveragePathIgnorePatterns',
  'coverageDirectory',
  'testRegex',
  'verbose',
  'globals',
  'displayName',
  'testEnvironmentOptions',
  'snapshotFormat',
  'clearMocks',
  'collectCoverage',
  'watchPathIgnorePatterns',
  'globalSetup',
  'modulePaths',
  'snapshotSerializers',
  'prettierPath',
  'resolver',
  'moduleDirectories',
  'runner',
  'fakeTimers',
  'extensionsToTreatAsEsm',
  'testRunner',
  'coverageProvider',
  'silent',
  'runtime',
  'resetMocks',
  'haste',
  'globalTeardown',
  'automock',
  'resetModules',
  'restoreMocks',
  'cacheDirectory',
  'snapshotResolver',
]

/** The global-config keys of the bar: the F4 keys only the global config has. */
export const GLOBAL_BAR_KEYS: readonly string[] = [
  'projects',
  'watchPlugins',
  'coverageReporters',
  'reporters',
  'coverageThreshold',
  'maxWorkers',
  'workerIdleMemoryLimit',
  'notify',
]

/** 46 + 8, plus `preset` (checked through its effects): the 55. */
export const BAR_KEY_COUNT: number = PROJECT_BAR_KEYS.length + GLOBAL_BAR_KEYS.length + 1

/** Global-config keys left out of every comparison. */
const UNCOMPARED_GLOBAL_KEYS: ReadonlySet<string> = new Set(['seed'])

const BAR_PACKAGES = ['babel-jest', 'jest-environment-node', 'jest-circus', 'jest-runner']
const REPORT_PACKAGES = [...BAR_PACKAGES, '@jest/test-sequencer']

/**
 * A path into one of `packages` as `<package>/<path inside it>`; anything else as it is. A bare
 * name (no Jest install resolved it) is its own package-relative form.
 */
export function packageRelative(value: string, packages: readonly string[]): string {
  for (const name of packages) {
    const marker = `/node_modules/${name}/`
    const at = value.lastIndexOf(marker)
    if (at !== -1) return `${name}/${value.slice(at + marker.length)}`
  }
  return value
}

/** A value as plain JSON the two sides can be compared on (and that crosses a process). */
export function encode(value: unknown, seen: readonly object[] = []): unknown {
  if (value === undefined) return { $undefined: true }
  if (typeof value === 'function') return { $function: value.toString() }
  if (typeof value === 'symbol') return { $symbol: String(value) }
  if (typeof value === 'bigint') return { $bigint: String(value) }
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  if (typeof value !== 'object' || value === null) return value
  if (seen.includes(value)) return { $circular: true }
  const inner = [...seen, value]
  if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value)) return value.map((item: unknown) => encode(item, inner))
  // Jest wraps the test path patterns in a `TestPathPatterns`; ours keeps the patterns.
  if (value.constructor?.name === 'TestPathPatterns') {
    return encode(Reflect.get(value, 'patterns'), inner)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = encode(Reflect.get(value, key), inner)
  return out
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item: unknown) => mapStrings(item, map))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, map)
    return out
  }
  return value
}

/** Deep equality on encoded (plain JSON) values. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key) =>
      Object.hasOwn(right, key) && sameValue(Reflect.get(left, key), Reflect.get(right, key)),
  )
}

/** One `readConfig` result as both checks carry it: encoded project and global configs. */
export interface EncodedRead {
  readonly projectConfig: Readonly<Record<string, unknown>>
  readonly globalConfig: Readonly<Record<string, unknown>>
}

/** A key that differs, with both values (package-relative forms applied). */
export interface KeyDifference {
  readonly key: string
  readonly ours: unknown
  readonly theirs: unknown
}

/** What a comparison found: the bar keys that differ, and the other keys that do. */
export interface Comparison {
  readonly bar: readonly KeyDifference[]
  readonly other: readonly KeyDifference[]
}

function differences(
  ours: Readonly<Record<string, unknown>>,
  theirs: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  prefix: string,
  packages: readonly string[],
): KeyDifference[] {
  const out: KeyDifference[] = []
  for (const key of keys) {
    const mine = mapStrings(ours[key], (text) => packageRelative(text, packages))
    const jest = mapStrings(theirs[key], (text) => packageRelative(text, packages))
    if (!sameValue(mine, jest)) out.push({ key: `${prefix}${key}`, ours: mine, theirs: jest })
  }
  return out
}

/** Compares our read with jest-config's: the bar, then every other key. */
export function compareReads(ours: EncodedRead, theirs: EncodedRead): Comparison {
  const projectKeys = new Set([
    ...Object.keys(ours.projectConfig),
    ...Object.keys(theirs.projectConfig),
  ])
  const globalKeys = new Set([
    ...Object.keys(ours.globalConfig),
    ...Object.keys(theirs.globalConfig),
  ])
  const otherProject = [...projectKeys].filter((key) => !PROJECT_BAR_KEYS.includes(key))
  const otherGlobal = [...globalKeys].filter(
    (key) => !GLOBAL_BAR_KEYS.includes(key) && !UNCOMPARED_GLOBAL_KEYS.has(key),
  )
  return {
    bar: [
      ...differences(ours.projectConfig, theirs.projectConfig, PROJECT_BAR_KEYS, '', BAR_PACKAGES),
      ...differences(
        ours.globalConfig,
        theirs.globalConfig,
        GLOBAL_BAR_KEYS,
        'global.',
        BAR_PACKAGES,
      ),
    ],
    other: [
      ...differences(ours.projectConfig, theirs.projectConfig, otherProject, '', REPORT_PACKAGES),
      ...differences(
        ours.globalConfig,
        theirs.globalConfig,
        otherGlobal,
        'global.',
        REPORT_PACKAGES,
      ),
    ],
  }
}

/** A short, one-line rendering of a value for a mismatch report. */
export function brief(value: unknown, limit = 160): string {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
