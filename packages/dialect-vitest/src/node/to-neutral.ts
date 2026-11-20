// B25c, T11.15: a resolved Vitest project as a `NeutralProject`: discovery, setup files, the
// environment, aliases and the policy keys its config sets. A key the reader reads and does not
// apply is a `VITEST_CONFIG_NOT_APPLIED` warning that names the phase that will (gap 9's rule), so
// nothing is dropped silently. Nothing here names a neutral package's internals: the values are
// policy keys over the dialect's own.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { moduleRef } from '@provino/policy'
import type {
  Diagnostic,
  JsonValue,
  ModuleMapperFactory,
  NeutralProject,
  PolicyOverrides,
  SerializedModuleMapper,
} from '@provino/types'
import { environmentOptionsKey } from '../internal/environment-options-key.ts'
import { VitestConfigError } from './errors.ts'
import { globToRegexSource } from './glob.ts'
import type { VitestResolvedProject } from './normalize.ts'
import { isRec, type Rec } from './util.ts'
import { mergeAlias, normalizeAlias } from './vite-merge.ts'

const SOURCE_EXTENSIONS: readonly string[] = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'tsx', 'jsx']

/** A key (dotted path into `test`) read and not applied yet, and the phase that applies it. */
const NOT_APPLIED: readonly (readonly [string, string])[] = [
  ['retry', 'B25g, with the command line (no policy key carries a retry count yet)'],
  ['bail', 'B25g, with the command line'],
  ['maxWorkers', 'B25g, with the command line'],
  ['minWorkers', 'B25g, with the command line'],
  ['fileParallelism', 'B25g, with the command line'],
  ['reporters', 'B25g, with the command line'],
  ['outputFile', 'B25g, with the command line'],
  ['coverage', 'B25h (Vitest coverage)'],
  ['fakeTimers', 'B25f (the vi facade)'],
  ['env', 'B25f: it reaches import.meta.env only; process.env needs the worker'],
  ['sequence.concurrent', 'B25e (fixtures and definitions in core)'],
  ['sequence.setupFiles', 'B25g'],
  ['onConsoleLog', 'B25g'],
  ['onStackTrace', 'B25g'],
  ['provide', 'B25g'],
  ['execArgv', 'B25g'],
  ['server', 'B25d (the Vite bridge)'],
  ['deps', 'B25d (the Vite bridge)'],
  ['css', 'B25d (the Vite bridge)'],
]

function read(record: Rec, path: string): unknown {
  let current: unknown = record
  for (const part of path.split('.')) {
    if (!isRec(current)) return undefined
    current = current[part]
  }
  return current
}

function jsonOf(value: unknown, key: string, diagnostics: Diagnostic[]): JsonValue | undefined {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : (JSON.parse(text) as JsonValue)
  } catch {
    diagnostics.push({
      level: 'warning',
      code: 'VITEST_CONFIG_NOT_SERIALIZABLE',
      message: `${key} can't cross to a worker as data and was dropped`,
      key,
    })
    return undefined
  }
}

function list(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** A `setupFiles`/`globalSetup`/`snapshotSerializers` entry as an absolute path. */
function absolute(entry: string, root: string, key: string): string {
  if (entry.startsWith('file:')) return new URL(entry).pathname
  if (entry.startsWith('.') || entry.startsWith('/')) return resolve(root, entry)
  try {
    return createRequire(join(root, 'noop.js')).resolve(entry)
  } catch (cause) {
    // Vitest reads a name that is no package as a path from the root (`vitest.setup.ts`).
    const fromRoot = resolve(root, entry)
    if (existsSync(fromRoot)) return fromRoot
    throw new VitestConfigError(
      'VITEST_CONFIG_INVALID',
      `${key}: can't resolve "${entry}" from ${root}`,
      { cause },
    )
  }
}

/**
 * Vite's `resolve.alias` merged with `test.alias` as the one mapper that applies plugin-alias's
 * rule exactly (`@provino/resolver`'s `viteAliasMapper`), or none when there are no entries.
 */
function viteAliasMappers(alias: unknown): SerializedModuleMapper[] {
  const aliases = normalizeAlias(alias).flatMap(({ find, replacement }) =>
    typeof replacement !== 'string' || !(typeof find === 'string' || find instanceof RegExp)
      ? []
      : [
          {
            find: typeof find === 'string' ? find : { source: find.source, flags: find.flags },
            replacement,
          },
        ],
  )
  if (aliases.length === 0) return []
  return [
    {
      factory: moduleRef<ModuleMapperFactory>(
        import.meta.resolve('@provino/resolver/vite-alias'),
        'viteAliasMapper',
      ),
      options: { aliases },
    },
  ]
}

/** A key read and not applied: a warning that names the phase that will. */
function notApplied(diagnostics: Diagnostic[], key: string, message: string): void {
  diagnostics.push({ level: 'warning', code: 'VITEST_CONFIG_NOT_APPLIED', message, key })
}

/** Each `sequence.hooks` value: the order of the `before` hooks, then of the `after` hooks (D60). */
const HOOK_ORDERS = {
  stack: ['declaration', 'reverse'],
  list: ['declaration', 'declaration'],
  parallel: ['parallel', 'parallel'],
} as const

/** Vitest's `sequence.hooks` as the policy's per-kind order (D60). */
function hookOrder(hooks: unknown): PolicyOverrides['core'] | undefined {
  if (typeof hooks !== 'string' || !Object.hasOwn(HOOK_ORDERS, hooks)) return undefined
  const [before, after] = HOOK_ORDERS[hooks as keyof typeof HOOK_ORDERS]
  return { hookOrder: { beforeAll: before, beforeEach: before, afterEach: after, afterAll: after } }
}

/**
 * Turns a resolved project into a neutral one, with the warnings for what it reads and doesn't
 * apply.
 * @public
 */
export function vitestProjectToNeutral(project: VitestResolvedProject): {
  readonly project: NeutralProject
  readonly diagnostics: readonly Diagnostic[]
} {
  const diagnostics: Diagnostic[] = []
  const { root, test, given } = project
  for (const [key, phase] of NOT_APPLIED) {
    if (read(given as Rec, key) === undefined) continue
    notApplied(
      diagnostics,
      `test.${key}`,
      `test.${key} is read and not applied yet: it comes with ${phase}`,
    )
  }
  for (const key of ['define', 'resolve.conditions', 'plugins']) {
    if (read(project.vite as Rec, key) === undefined) continue
    if (key === 'plugins' && !project.needsVite) continue
    notApplied(
      diagnostics,
      key,
      key === 'plugins'
        ? 'plugins are read by the Vite bridge (`@provino/dialect-vitest/vite-bridge`) and hosted by `@provino/transform/vite`; running them in a worker comes with B25g'
        : `${key} is read and not applied yet: the Vite bridge reads it, and a worker applies it with B25f`,
    )
  }
  const sequence = isRec(test.sequence) ? test.sequence : {}
  const shuffle = sequence.shuffle
  const shuffleTests = shuffle === true || (isRec(shuffle) && shuffle.tests === true)
  if (isRec(shuffle) && shuffle.files === true) {
    notApplied(
      diagnostics,
      'test.sequence.shuffle.files',
      'test.sequence.shuffle.files is read and not applied yet: it comes with B25g',
    )
  }
  const environmentName = typeof test.environment === 'string' ? test.environment : 'node'
  const environmentOptions = isRec(test.environmentOptions) ? test.environmentOptions : {}
  const options = environmentOptions[environmentOptionsKey(environmentName)]
  const environmentJson = isRec(options)
    ? (jsonOf(options, 'test.environmentOptions', diagnostics) ?? {})
    : {}
  const viteAlias = isRec(project.vite.resolve) ? project.vite.resolve.alias : undefined
  // Vitest merges `test.alias` into `resolve.alias` with Vite's `mergeAlias` (recorded: a `test.alias`
  // entry wins over a `resolve.alias` entry with the same find, `resolve/vite-alias-order`).
  const mappers = viteAliasMappers(mergeAlias(viteAlias, test.alias))
  const include = list(test.include)
  const exclude = list(test.exclude)
  const dir = typeof test.dir === 'string' ? resolve(root, test.dir) : root
  const serializers = list(test.snapshotSerializers).map((entry) =>
    absolute(entry, root, 'test.snapshotSerializers'),
  )
  const format = isRec(test.snapshotFormat) ? test.snapshotFormat : undefined
  const { escapeString, printBasicPrototype, ...otherFormat } = format ?? {}
  const pool = test.pool === 'threads' ? 'threads' : 'forks'
  const isolate = test.isolate !== false
  const seed = typeof sequence.seed === 'number' ? sequence.seed : undefined
  const core: NonNullable<PolicyOverrides['core']> = {
    injectGlobals: test.globals === true,
    ...(typeof test.maxConcurrency === 'number' ? { maxConcurrency: test.maxConcurrency } : {}),
    timeouts: {
      ...(typeof test.testTimeout === 'number' ? { test: test.testTimeout } : {}),
      ...(typeof test.hookTimeout === 'number' ? { hook: test.hookTimeout } : {}),
      ...(typeof test.teardownTimeout === 'number' ? { teardown: test.teardownTimeout } : {}),
    },
    ...(hookOrder(sequence.hooks) ?? {}),
  }
  const policy: PolicyOverrides = {
    core,
    mock: {
      between: {
        clear: test.clearMocks === true,
        reset: test.mockReset === true,
        restore: test.restoreMocks === true,
        unstubEnvs: test.unstubEnvs === true,
        unstubGlobals: test.unstubGlobals === true,
      },
    },
    orchestrator: {
      include,
      exclude,
      pool: { default: pool },
      ...(isolate
        ? {}
        : {
            isolationDefault: {
              default: 'none',
              byEnvironment: { jsdom: 'none', 'happy-dom': 'none' },
            },
          }),
      passWithNoTests: test.passWithNoTests === true,
      ...(typeof test.slowTestThreshold === 'number'
        ? { slowTestThresholdMs: test.slowTestThreshold }
        : {}),
    },
    snapshot: {
      serializers,
      ...(format === undefined
        ? {}
        : {
            format: {
              ...(typeof escapeString === 'boolean' ? { escapeString } : {}),
              ...(typeof printBasicPrototype === 'boolean' ? { printBasicPrototype } : {}),
              extra: (jsonOf(otherFormat, 'test.snapshotFormat', diagnostics) ?? {}) as Record<
                string,
                JsonValue
              >,
            },
          }),
    },
  }
  const neutral: NeutralProject = {
    name: project.name,
    rootDir: root,
    discovery: {
      roots: [dir],
      extensions: [...SOURCE_EXTENSIONS],
      includePatterns: { kind: 'glob', patterns: include },
      excludePatterns: exclude.map((glob) => globToRegexSource(glob, root)),
      crawlIgnorePatterns: [],
    },
    setupFiles: [],
    setupFilesAfterEnv: list(test.setupFiles).map((entry) =>
      absolute(entry, root, 'test.setupFiles'),
    ),
    globalSetup: list(test.globalSetup).map((entry) => absolute(entry, root, 'test.globalSetup')),
    globalTeardown: [],
    environment: {
      name: environmentName,
      options: environmentJson as Record<string, JsonValue>,
      // A docblock environment with no `-options` gets the whole object (Vitest 5.0.5's
      // `runtime/workers/base.ts`: `environmentOptions || config.environmentOptions || {}`).
      resolverOptions: (jsonOf(environmentOptions, 'test.environmentOptions', diagnostics) ??
        {}) as Record<string, JsonValue>,
    },
    aliases: [],
    ...(mappers.length === 0 ? {} : { mappers }),
    transforms: [],
    transformIgnorePatterns: [],
    snapshotSerializers: serializers,
    importMetaEnv: project.importMetaEnv,
    ...(seed === undefined ? {} : { seed }),
    ...(shuffleTests ? { randomize: true as const } : {}),
    policy,
  }
  return { project: neutral, diagnostics }
}
