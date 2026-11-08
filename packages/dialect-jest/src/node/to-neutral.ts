// T11.6's second half: a normalized Jest project config as a `NeutralProject`, the data
// `@provino/config`'s `resolveNeutralProject` builds a run from. Every path is absolute already;
// patterns stay sources (no `RegExp`), and option objects must be JSON (a function or other value
// that can't cross to a worker is dropped with a warning naming it). Keys Provino reads but doesn't
// apply yet warn, naming the task that builds them (gap 9 of `bundles/B14.md`: nothing is ignored
// silently).
import type {
  Diagnostic,
  JsonValue,
  NeutralAlias,
  NeutralProject,
  NeutralTransform,
  PolicyOverrides,
} from '@provino/types'
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

/** The default transform `normalize` injects: `babel-jest` for `\.[jt]sx?$`. */
const DEFAULT_JS_PATTERN = '\\.[jt]sx?$'

function packageOf(path: string, name: string): boolean {
  return path === name || path.startsWith(`${name}/`) || path.includes(`/node_modules/${name}/`)
}

/**
 * The neutral environment name for a resolved Jest `testEnvironment`: `node`, `jsdom` or
 * `happy-dom` for the packages that provide them, else the path itself.
 * @public
 */
export function neutralEnvironmentName(testEnvironment: string): string {
  if (packageOf(testEnvironment, 'jest-environment-node')) return 'node'
  if (packageOf(testEnvironment, 'jest-environment-jsdom')) return 'jsdom'
  if (packageOf(testEnvironment, '@happy-dom/jest-environment')) return 'happy-dom'
  return testEnvironment
}

/** A value as JSON, or `undefined` (with each path that couldn't be kept in `dropped`). */
function toJson(value: unknown, path: string, dropped: string[]): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    dropped.push(path)
    return undefined
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => toJson(item, `${path}[${index}]`, dropped) ?? null)
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      const json = toJson(item, `${path}.${key}`, dropped)
      if (json !== undefined) out[key] = json
    }
    return out
  }
  if (value !== undefined) dropped.push(path)
  return undefined
}

function jsonObject(
  value: unknown,
  key: string,
  diagnostics: Diagnostic[],
): Readonly<Record<string, JsonValue>> {
  const dropped: string[] = []
  const json = toJson(value ?? {}, key, dropped)
  for (const path of dropped) {
    diagnostics.push({
      level: 'warning',
      code: 'JEST_CONFIG_NOT_SERIALIZABLE',
      key: path,
      message: `Jest config value "${path}" can't be carried to a test worker (only JSON values can), so it is left out.`,
    })
  }
  if (typeof json !== 'object' || json === null || isJsonArray(json)) return {}
  return json
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function notApplied(diagnostics: Diagnostic[], key: string, owner: string, detail = ''): void {
  diagnostics.push({
    level: 'warning',
    code: 'JEST_CONFIG_NOT_APPLIED',
    key,
    message: `Jest config key "${key}" is read but not applied yet (${owner} builds it)${detail}.`,
  })
}

function isDefaultTransform(transform: JestProjectConfig['transform']): boolean {
  const [only, ...rest] = transform
  return (
    only !== undefined &&
    rest.length === 0 &&
    only[0] === DEFAULT_JS_PATTERN &&
    packageOf(only[1], 'babel-jest') &&
    Object.keys(only[2] ?? {}).length === 0
  )
}

/**
 * One normalized project as a `NeutralProject`, with a warning for each key it reads but doesn't
 * apply yet. `globalConfig` is the run's (`passWithNoTests`, `maxConcurrency`, the global-only keys).
 * @public
 */
export function jestProjectToNeutral(
  project: JestProjectConfig,
  globalConfig: JestGlobalConfig,
): { readonly project: NeutralProject; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const environment = neutralEnvironmentName(project.testEnvironment)
  if (environment !== 'node') {
    notApplied(
      diagnostics,
      'testEnvironment',
      environment === 'jsdom' || environment === 'happy-dom' ? 'T8.3' : 'T8.5',
      `; "${environment}" is not a built-in environment yet`,
    )
  }
  if (!isDefaultTransform(project.transform)) {
    notApplied(diagnostics, 'transform', 'T3.8', "; Provino's own transform runs instead")
  }
  if (project.moduleNameMapper.length > 0) notApplied(diagnostics, 'moduleNameMapper', 'T3.3')
  if (project.resolver !== undefined) notApplied(diagnostics, 'resolver', 'T3.3')
  if (project.modulePaths !== undefined && project.modulePaths.length > 0) {
    notApplied(diagnostics, 'modulePaths', 'T3.3')
  }
  if (project.snapshotSerializers.length > 0) {
    notApplied(diagnostics, 'snapshotSerializers', 'T7.10')
  }
  if (project.snapshotResolver !== undefined) notApplied(diagnostics, 'snapshotResolver', 'T7.9')
  if (project.fakeTimers.enableGlobally === true) notApplied(diagnostics, 'fakeTimers', 'T4.9')
  if (project.globalSetup !== undefined) notApplied(diagnostics, 'globalSetup', 'Track 9')
  if (project.globalTeardown !== undefined) notApplied(diagnostics, 'globalTeardown', 'Track 9')
  if (globalConfig.collectCoverage) notApplied(diagnostics, 'collectCoverage', 'T8.8')
  if (globalConfig.reporters !== undefined) notApplied(diagnostics, 'reporters', 'T11.9')

  const aliases: NeutralAlias[] = project.moduleNameMapper.map(([pattern, target]) => ({
    pattern,
    targets: typeof target === 'string' ? [target] : [...target],
  }))
  const transforms: NeutralTransform[] = project.transform.map(([pattern, module, options]) => ({
    pattern,
    module,
    options: jsonObject(options, `transform["${pattern}"]`, diagnostics),
  }))
  const mock = {
    between: {
      clear: project.clearMocks,
      reset: project.resetMocks,
      restore: project.restoreMocks,
    },
  }
  const policy: PolicyOverrides = {
    core: {
      injectGlobals: project.injectGlobals,
      maxConcurrency: globalConfig.maxConcurrency,
      ...(project.testTimeout === undefined ? {} : { timeouts: { test: project.testTimeout } }),
    },
    mock,
    orchestrator: {
      passWithNoTests: globalConfig.passWithNoTests,
      slowTestThresholdMs: project.slowTestThreshold * 1000,
      // `testFailureExitCode` is what Jest exits with when the run didn't succeed: a failed test
      // or file, and an error outside the tests (`readResultsAndExit`).
      exitCodes: {
        failure: globalConfig.testFailureExitCode,
        unhandled: globalConfig.testFailureExitCode,
      },
    },
  }
  const neutral: NeutralProject = {
    name: project.displayName?.name ?? '',
    rootDir: project.rootDir,
    discovery: {
      roots: [...project.roots],
      extensions: [...project.moduleFileExtensions],
      includePatterns:
        project.testRegex.length > 0
          ? { kind: 'regex', patterns: [...project.testRegex] }
          : { kind: 'glob', patterns: [...project.testMatch] },
      excludePatterns: [...project.testPathIgnorePatterns],
      crawlIgnorePatterns: [
        ...project.modulePathIgnorePatterns,
        // jest-runtime `createHasteMap`: a cache directory inside the root is not crawled. It
        // joins the ignore regular expression as it is, unescaped, as Jest builds it.
        ...(project.cacheDirectory.startsWith(`${project.rootDir}/`)
          ? [project.cacheDirectory]
          : []),
      ],
    },
    setupFiles: [...project.setupFiles],
    setupFilesAfterEnv: [...project.setupFilesAfterEnv],
    globalSetup: project.globalSetup === undefined ? [] : [project.globalSetup],
    globalTeardown: project.globalTeardown === undefined ? [] : [project.globalTeardown],
    environment: {
      name: environment,
      options: jsonObject(project.testEnvironmentOptions, 'testEnvironmentOptions', diagnostics),
    },
    aliases,
    transforms,
    transformIgnorePatterns: [...project.transformIgnorePatterns],
    snapshotSerializers: [...project.snapshotSerializers],
    policy,
  }
  return { project: neutral, diagnostics }
}
