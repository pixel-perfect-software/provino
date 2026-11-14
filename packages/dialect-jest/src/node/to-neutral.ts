// T11.6's second half: a normalized Jest project config as a `NeutralProject`, the data
// `@provino/config`'s `resolveNeutralProject` builds a run from. Every path is absolute already;
// patterns stay sources (no `RegExp`), and option objects must be JSON (a function or other value
// that can't cross to a worker is dropped with a warning naming it). Keys Provino reads but doesn't
// apply yet warn, naming the task that builds them (gap 9 of `bundles/B14.md`: nothing is ignored
// silently).

import { createRequire } from 'node:module'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type {
  Diagnostic,
  JsonValue,
  NeutralAlias,
  NeutralProject,
  NeutralTransform,
  PolicyOverrides,
} from '@provino/types'
import { hasBabelConfig } from './babel-config.ts'
import { jestHookArgs, jestRunGlobalHooks, list } from './global-hooks.ts'
import { type JestRequireResolve, projectJestRequireResolve } from './resolution.ts'
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

/**
 * Where the project's Prettier is, for the inline snapshot writer (B23d B1): `prettierPath` as the
 * config gave it, an absolute path when jest-config resolved it. The default (`prettier`) stays a
 * name that jest-snapshot resolves from Jest's own install (`require.resolve` in
 * `InlineSnapshots.ts` L56): here from the project's root first, then from Jest's install; `null`
 * when neither has it, which Jest's `MODULE_NOT_FOUND` catch makes "no formatting" too.
 */
function prettierPathOf(
  project: JestProjectConfig,
  requireResolve: JestRequireResolve | undefined,
): string | null {
  const { prettierPath } = project
  if (prettierPath === null || isAbsolute(prettierPath)) return prettierPath
  try {
    return createRequire(join(project.rootDir, 'package.json')).resolve(prettierPath)
  } catch {
    return (requireResolve ?? projectJestRequireResolve(project.rootDir))(prettierPath) ?? null
  }
}

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

/** The `NODE_PATH` directories, absolute against `cwd`, as jest-resolve reads them. */
function nodePathEntries(cwd: string, env: NodeJS.ProcessEnv): string[] {
  return (env.NODE_PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '')
    .map((entry) => resolve(cwd, entry))
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

/** What `jestProjectToNeutral` needs besides the normalized config. */
export interface ToNeutralOptions {
  /** Whether the config named a `cacheDirectory`, so it is the user's (D70). Default: no. */
  readonly cacheDirectorySet?: boolean
  /** The variables Jest reads (`NODE_PATH`). Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Where Jest's own packages resolve from. Default: the project's own Jest. */
  readonly requireResolve?: JestRequireResolve
}

/**
 * One normalized project as a `NeutralProject`, with a warning for each key it reads but doesn't
 * apply yet. `globalConfig` is the run's (`passWithNoTests`, `maxConcurrency`, the global-only keys).
 * @public
 */
export function jestProjectToNeutral(
  project: JestProjectConfig,
  globalConfig: JestGlobalConfig,
  options: ToNeutralOptions = {},
): { readonly project: NeutralProject; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  // Each JSON view of the config once, so a value that can't be cloned warns once.
  const testEnvironmentOptions = jsonObject(
    project.testEnvironmentOptions,
    'testEnvironmentOptions',
    diagnostics,
  )
  const globalValues = jsonObject(project.globals, 'globals', diagnostics)
  const fakeTimers = jsonObject(project.fakeTimers, 'fakeTimers', diagnostics)
  // Decision D44: `jest-environment-node` is the built-in `node`; every other environment, jsdom
  // included, is the project's own Jest environment class, named by its path and run through the
  // adapter (`jestEnvironment`), so the DOM is the one Jest would build.
  const isNode = neutralEnvironmentName(project.testEnvironment) === 'node'
  const environment = isNode ? 'node' : project.testEnvironment
  if (globalConfig.collectCoverage) notApplied(diagnostics, 'collectCoverage', 'T8.8')

  const aliases: NeutralAlias[] = project.moduleNameMapper.map(([pattern, target]) => ({
    pattern,
    targets: typeof target === 'string' ? [target] : [...target],
  }))
  // Jest's default `babel-jest` entry, with no options, stays Provino's own Oxc transform when the
  // project has no Babel config: babel-jest then only hoists, which our hoister matches (D7). With
  // a Babel config (D68) it runs as Jest runs it, plugins and presets included, as does any
  // transform the config names itself (T3.8).
  const implicit = isDefaultTransform(project.transform)
  const babelJestResolved =
    (options.requireResolve ?? projectJestRequireResolve(project.rootDir))('babel-jest') !==
    undefined
  const withBabel = implicit && hasBabelConfig(project.rootDir)
  // A project that dropped Jest for Provino may keep a Babel config for its app build while no
  // `babel-jest` resolves: the implicit entry is not worth failing the run, the Oxc path runs.
  if (withBabel && !babelJestResolved) {
    diagnostics.push({
      level: 'warning',
      code: 'JEST_CONFIG_NOT_APPLIED',
      key: 'transform',
      message:
        "The project's Babel config was not applied: babel-jest is not installed, so Provino's own transform runs instead.",
    })
  }
  const skipImplicit = implicit && !(withBabel && babelJestResolved)
  const transforms: NeutralTransform[] = skipImplicit
    ? []
    : project.transform.map(([pattern, module, options]) => ({
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
  // `snapshotFormat` is pretty-format's options, already merged over Jest's two defaults: the two
  // the policy types go in their keys, the rest (`indent`, `maxDepth`, `min`, ...) in `extra`.
  const { escapeString, printBasicPrototype, ...otherFormat } = project.snapshotFormat
  const policy: PolicyOverrides = {
    core: {
      injectGlobals: project.injectGlobals,
      maxConcurrency: globalConfig.maxConcurrency,
      // circus runs hooks with `hook.timeout || getState().testTimeout`, and `testTimeout` is
      // `globalConfig.testTimeout`: the one value is the default of tests and of hooks.
      ...(project.testTimeout === undefined
        ? {}
        : {
            timeouts: {
              test: project.testTimeout,
              hook: project.testTimeout,
              teardown: project.testTimeout,
            },
          }),
    },
    mock,
    // jest-circus installs the fake clock for every file when `fakeTimers.enableGlobally` is set.
    ...(project.fakeTimers.enableGlobally === true ? { timers: { enableGlobally: true } } : {}),
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
    snapshot: {
      serializers: [...project.snapshotSerializers],
      // `prettierPath` as jest-config resolved it (a path, or `null`: Jest's default is optional,
      // so a project without Prettier has none), for the inline snapshot writer (B23d B1).
      inline: { prettierPath: prettierPathOf(project, options.requireResolve) },
      format: {
        ...(typeof escapeString === 'boolean' ? { escapeString } : {}),
        ...(typeof printBasicPrototype === 'boolean' ? { printBasicPrototype } : {}),
        extra: jsonObject(otherFormat, 'snapshotFormat', diagnostics),
      },
    },
  }
  const globalSetup = list(project.globalSetup)
  const globalTeardown = list(project.globalTeardown)
  const hasGlobalHooks =
    globalSetup.length > 0 ||
    globalTeardown.length > 0 ||
    jestRunGlobalHooks(globalConfig) !== undefined
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
    globalSetup,
    globalTeardown,
    // `fn(globalConfig, projectConfig)`: Jest's own two configs, as they are (a hook runs in the
    // coordinator, so they need not be JSON: nothing is lost to it). The run's own hooks (the root
    // config's, with `projects`) are called with the first project's config, whichever project
    // that is: every project keeps the two.
    ...(hasGlobalHooks ? { globalSetupArgs: jestHookArgs(project, globalConfig) } : {}),
    environment: {
      name: environment,
      // One shape for every environment: the adapter's class (absent for the built-in `node`) and
      // what a Jest environment class reads of `projectConfig`.
      options: {
        ...(isNode ? {} : { module: project.testEnvironment }),
        projectConfig: {
          rootDir: project.rootDir,
          cwd: project.cwd,
          testEnvironment: project.testEnvironment,
          testEnvironmentOptions,
          globals: globalValues,
          fakeTimers,
          injectGlobals: project.injectGlobals,
        },
      },
    },
    aliases,
    globalValues,
    // What every install is layered over (jest-runtime `useFakeTimers`: `{...config.fakeTimers, ...own}`).
    fakeTimers: Object.fromEntries(
      Object.entries(fakeTimers).filter(([key]) => key !== 'enableGlobally'),
    ),
    seed: globalConfig.seed,
    ...(globalConfig.randomize === true ? { randomize: true as const } : {}),
    resolution: {
      moduleDirectories: [...project.moduleDirectories],
      // Jest's resolver searches `NODE_PATH` before `modulePaths` (`jest-resolve` `Resolver`).
      modulePaths: [
        ...nodePathEntries(project.cwd, options.env ?? process.env),
        ...(project.modulePaths ?? []),
      ],
      ...(project.resolver === undefined ? {} : { resolver: project.resolver }),
    },
    transforms,
    transformIgnorePatterns: [...project.transformIgnorePatterns],
    // What a transformer reads as `config`: the project config as JSON (ts-jest reads `rootDir`,
    // `cwd`, `globals` and `testMatch` from it). Nothing in a normalized config fails to clone.
    ...(transforms.length === 0
      ? {}
      : {
          transformConfig: jsonObject(project, 'transformConfig', []),
          // babel-plugin-jest-hoist 30.5.0 writes `_getJestObj` into every file it hoists in
          // (recorded in `packages/transform/src/jest-host/host.test.ts`'s fixture).
          transformHoistedMarkers: ['_getJestObj'],
        }),
    snapshotSerializers: [...project.snapshotSerializers],
    ...(project.snapshotResolver === undefined
      ? {}
      : { snapshotResolver: project.snapshotResolver }),
    // Jest's `/tmp/jest_*` default is not Provino's to use (D70); a directory the config chose is.
    ...(options.cacheDirectorySet === true ? { cacheDirectory: project.cacheDirectory } : {}),
    policy,
  }
  return { project: neutral, diagnostics }
}
