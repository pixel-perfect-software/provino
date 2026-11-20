// B25c, T11.15: a resolved Vitest project as a `NeutralProject`: discovery, setup files, the
// environment, aliases and the policy keys its config sets. A key the reader reads and does not
// apply is a `VITEST_CONFIG_NOT_APPLIED` warning that names the phase that will (gap 9's rule), so
// nothing is dropped silently. Nothing here names a neutral package's internals: the values are
// policy keys over the dialect's own.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type {
  Diagnostic,
  JsonValue,
  NeutralAlias,
  NeutralProject,
  PolicyOverrides,
} from '@provino/types'
import { VitestConfigError } from './errors.ts'
import { globToRegexSource } from './glob.ts'
import type { VitestResolvedProject } from './normalize.ts'

type Rec = Record<string, unknown>

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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
    throw new VitestConfigError(
      'VITEST_CONFIG_INVALID',
      `${key}: can't resolve "${entry}" from ${root}`,
      { cause },
    )
  }
}

function regexGroups(source: string): number {
  return (new RegExp(`${source}|`).exec('') ?? []).length - 1
}

/** `$&`, `$\``, `$'` and `$<name>` have no counterpart in a mapped target. */
const UNMAPPABLE_REPLACEMENT = /\$[&`'<]/

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Vite's `resolve.alias` entries (object or list) as the neutral alias rules, which replace whole
 * specifiers with `$n` targets: a string `find` matches the specifier or a path under it, a RegExp
 * replaces its match (head and tail kept). `@provino/resolver`'s `viteAliasMapper` is the same rule
 * written directly; this form is what the loader's alias list carries today.
 * @public
 */
export function viteAliasesToNeutral(
  alias: unknown,
  diagnostics: Diagnostic[],
  key: string,
): NeutralAlias[] {
  const entries: { find: unknown; replacement: unknown }[] = Array.isArray(alias)
    ? alias.filter(isRec).map((entry) => ({ find: entry.find, replacement: entry.replacement }))
    : isRec(alias)
      ? Object.entries(alias).map(([find, replacement]) => ({ find, replacement }))
      : []
  const out: NeutralAlias[] = []
  for (const { find, replacement } of entries) {
    if (typeof replacement !== 'string' || UNMAPPABLE_REPLACEMENT.test(replacement)) {
      diagnostics.push({
        level: 'warning',
        code: 'VITEST_CONFIG_NOT_APPLIED',
        message: `${key}: the alias for ${String(find)} has a replacement this reader can't map and was dropped`,
        key,
      })
      continue
    }
    if (typeof find === 'string') {
      const base = find.endsWith('/') && replacement.endsWith('/') ? find.slice(0, -1) : find
      const target =
        find.endsWith('/') && replacement.endsWith('/') ? replacement.slice(0, -1) : replacement
      out.push({ pattern: `^${escapeRegex(base)}(/.*)?$`, targets: [`${target}$1`] })
    } else if (find instanceof RegExp) {
      if (/[^gdu]/.test(find.flags.replace(/[gdu]/g, ''))) {
        diagnostics.push({
          level: 'warning',
          code: 'VITEST_CONFIG_NOT_APPLIED',
          message: `${key}: the alias ${String(find)} has flags (${find.flags}) the neutral alias can't carry and was dropped`,
          key,
        })
        continue
      }
      const groups = regexGroups(find.source)
      const shifted = replacement.replace(
        /\$(\d+)/g,
        (_, digits: string) => `$${Number(digits) + 1}`,
      )
      out.push({
        pattern: `^(.*?)(?:${find.source})(.*)$`,
        targets: [`$1${shifted}$${groups + 2}`],
      })
    }
  }
  return out
}

/** Vitest's `sequence.hooks` as the policy's per-kind order (D60). */
function hookOrder(hooks: unknown): PolicyOverrides['core'] | undefined {
  if (hooks === 'stack') {
    return {
      hookOrder: {
        beforeAll: 'declaration',
        beforeEach: 'declaration',
        afterEach: 'reverse',
        afterAll: 'reverse',
      },
    }
  }
  if (hooks === 'list') {
    return {
      hookOrder: {
        beforeAll: 'declaration',
        beforeEach: 'declaration',
        afterEach: 'declaration',
        afterAll: 'declaration',
      },
    }
  }
  if (hooks === 'parallel') {
    return {
      hookOrder: {
        beforeAll: 'parallel',
        beforeEach: 'parallel',
        afterEach: 'parallel',
        afterAll: 'parallel',
      },
    }
  }
  return undefined
}

const ENVIRONMENT_OPTION_KEY: Readonly<Record<string, string>> = {
  'happy-dom': 'happyDOM',
  'edge-runtime': 'edgeRuntime',
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
    diagnostics.push({
      level: 'warning',
      code: 'VITEST_CONFIG_NOT_APPLIED',
      message: `test.${key} is read and not applied yet: it comes with ${phase}`,
      key: `test.${key}`,
    })
  }
  for (const key of ['define', 'resolve.conditions', 'plugins']) {
    if (read(project.vite as Rec, key) === undefined) continue
    if (key === 'plugins' && project.vite.plugins !== undefined && !project.needsVite) continue
    diagnostics.push({
      level: 'warning',
      code: 'VITEST_CONFIG_NOT_APPLIED',
      message: `${key} is read and not applied yet: it comes with B25d (the Vite bridge and the transform)`,
      key,
    })
  }
  const sequence = isRec(test.sequence) ? test.sequence : {}
  const shuffle = sequence.shuffle
  const shuffleTests = shuffle === true || (isRec(shuffle) && shuffle.tests === true)
  if (isRec(shuffle) && shuffle.files === true) {
    diagnostics.push({
      level: 'warning',
      code: 'VITEST_CONFIG_NOT_APPLIED',
      message: 'test.sequence.shuffle.files is read and not applied yet: it comes with B25g',
      key: 'test.sequence.shuffle.files',
    })
  }
  const environmentName = typeof test.environment === 'string' ? test.environment : 'node'
  const environmentOptions = isRec(test.environmentOptions) ? test.environmentOptions : {}
  const options = environmentOptions[ENVIRONMENT_OPTION_KEY[environmentName] ?? environmentName]
  const environmentJson = isRec(options)
    ? (jsonOf(options, 'test.environmentOptions', diagnostics) ?? {})
    : {}
  const viteAlias = isRec(project.vite.resolve) ? project.vite.resolve.alias : undefined
  const aliases = [
    ...viteAliasesToNeutral(viteAlias, diagnostics, 'resolve.alias'),
    ...viteAliasesToNeutral(test.alias, diagnostics, 'test.alias'),
  ]
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
    environment: { name: environmentName, options: environmentJson as Record<string, JsonValue> },
    aliases,
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
