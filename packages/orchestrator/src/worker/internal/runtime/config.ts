// The project config arrives in `WorkerInit` typed, but it crossed a link: the worker checks that
// every piece it reads is there before it builds anything, so a malformed config fails with a code
// and the name of the key, instead of a `TypeError` from the middle of the boot. The policy's data
// keys are checked where they are used; where its behaviour refs point is checked here (D21).
import { isAbsolute } from 'node:path'
import { forEachModuleRef, isImportableLocation, isModuleRef, neutralPolicy } from '@provino/policy'
import type {
  EnvironmentRef,
  GlobalsFactory,
  HoistPolicy,
  ModuleRef,
  ModuleScopeFactory,
  SerializedLoaderConfig,
  SerializedModuleMapper,
  SerializedPolicy,
  SerializedProjectConfig,
} from '@provino/types'
import { WorkerError } from '../../errors.ts'
import { isRecord, isStringArray } from './guards.ts'

const TYPESCRIPT_MODES: readonly unknown[] = ['oxc', 'node-strip', 'off']

function invalid(path: string, expected: string): never {
  throw new WorkerError(
    'ORCH_BAD_CONFIG',
    `The project config is invalid: ${path} must be ${expected}`,
  )
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : invalid(path, 'an object')
}

function text(value: unknown, path: string): string {
  return typeof value === 'string' ? value : invalid(path, 'a string')
}

function texts(value: unknown, path: string): readonly string[] {
  return isStringArray(value) ? value : invalid(path, 'an array of strings')
}

/**
 * A module location a worker can import as it is: an absolute path or an absolute URL (`file:`,
 * `data:`, `node:`). A bare package specifier would resolve from this package's own location, which
 * is not the project's, so the coordinator resolves those before the config crosses.
 */
function moduleLocation(value: unknown, path: string): string {
  const location = text(value, path)
  if (!isImportableLocation(location)) {
    return invalid(
      path,
      'an absolute path or URL, such as a file: URL (the coordinator resolves package specifiers)',
    )
  }
  return location
}

/**
 * Every slice of the policy is there as an object (the shape `SerializedPolicy` promises) and every
 * behaviour ref in it is absolute.
 */
function serializedPolicy(value: unknown): SerializedPolicy {
  const policy = record(value, 'policy')
  for (const slice of Object.keys(neutralPolicy)) record(policy[slice], `policy.${slice}`)
  // Every behaviour in the policy is a `{ module, export }` ref under its slice (D21): a worker
  // imports each `module` as it is, so each is absolute like the environment's, the policy's own
  // refs (`neutralPolicy`'s, a dialect's) included.
  forEachModuleRef(policy, 'policy', (ref, path) => {
    moduleLocation(ref.module, `${path}.module`)
  })
  // The project's snapshot serializers are imported through the file's registry as they are.
  absolutePaths(
    record(policy.snapshot, 'policy.snapshot').serializers,
    'policy.snapshot.serializers',
  )
  return policy as SerializedPolicy
}

/**
 * A path a worker uses as it is: absolute, because a relative one would resolve against the
 * worker's own working directory, not the project's. The coordinator resolves them (D21).
 */
function absolutePath(value: unknown, path: string): string {
  const location = text(value, path)
  return isAbsolute(location)
    ? location
    : invalid(path, 'an absolute path (the coordinator resolves it)')
}

function absolutePaths(value: unknown, path: string): readonly string[] {
  return texts(value, path).map((item, index) => absolutePath(item, `${path}[${index}]`))
}

function environmentRef(value: unknown): EnvironmentRef {
  const ref = record(value, 'environment')
  return {
    module: moduleLocation(ref.module, 'environment.module'),
    export: text(ref.export, 'environment.export'),
    options: record(ref.options, 'environment.options') as EnvironmentRef['options'],
  }
}

/** The globals ref, or `null` for a dialect that injects none. */
function globalsRef(value: unknown): ModuleRef<GlobalsFactory> | null {
  if (value === null) return null
  if (!isModuleRef(value)) invalid('globals', 'null or a { module, export } ref')
  return { module: moduleLocation(value.module, 'globals.module'), export: value.export }
}

/** Each mapper is a `{ factory, options }`: a ref to its factory and the data it is called with. */
function mapperList(value: unknown): readonly SerializedModuleMapper[] {
  if (!Array.isArray(value)) return invalid('loader.mappers', 'an array')
  return value.map((item: unknown, index): SerializedModuleMapper => {
    const path = `loader.mappers[${index}]`
    const mapper = record(item, path)
    if (!isModuleRef(mapper.factory)) invalid(`${path}.factory`, 'a { module, export } ref')
    if (!('options' in mapper)) invalid(`${path}.options`, 'present (null for none)')
    const { module, export: name } = mapper.factory
    return {
      factory: { module: moduleLocation(module, `${path}.factory.module`), export: name },
      options: mapper.options as SerializedModuleMapper['options'],
    }
  })
}

/**
 * The dialect's hoist policy, or `null`. It is data (`RegExp` and `Set` leaves clone as they are),
 * so the shape check is the slice's own: the hoister reads the keys it needs.
 */
function hoistPolicy(value: unknown): HoistPolicy | null {
  if (value === null) return null
  const hoist = record(value, 'loader.hoist')
  text(hoist.id, 'loader.hoist.id')
  record(hoist.hoistCalls, 'loader.hoist.hoistCalls')
  record(hoist.messages, 'loader.hoist.messages')
  return value as HoistPolicy
}

/** The module-scope factory's ref, or `null` for a dialect with none. */
function moduleScopeRef(value: unknown): ModuleRef<ModuleScopeFactory> | null {
  if (value === null) return null
  if (!isModuleRef(value)) invalid('moduleScope', 'null or a { module, export } ref')
  return { module: moduleLocation(value.module, 'moduleScope.module'), export: value.export }
}

/** The optional resolver keys (T3.3); an absent one stays absent. */
function resolverKeys(loader: Record<string, unknown>): Partial<SerializedLoaderConfig> {
  const keys: { -readonly [K in keyof SerializedLoaderConfig]?: SerializedLoaderConfig[K] } = {}
  if (loader.aliases !== undefined) {
    if (!Array.isArray(loader.aliases)) invalid('loader.aliases', 'an array')
    keys.aliases = loader.aliases.map((item: unknown, index) => {
      const alias = record(item, `loader.aliases[${index}]`)
      return {
        pattern: text(alias.pattern, `loader.aliases[${index}].pattern`),
        targets: texts(alias.targets, `loader.aliases[${index}].targets`),
      }
    })
  }
  if (loader.moduleDirectories !== undefined) {
    keys.moduleDirectories = texts(loader.moduleDirectories, 'loader.moduleDirectories')
  }
  if (loader.modulePaths !== undefined) {
    keys.modulePaths = absolutePaths(loader.modulePaths, 'loader.modulePaths')
  }
  if (loader.resolver !== undefined && loader.resolver !== null) {
    if (!isModuleRef(loader.resolver))
      invalid('loader.resolver', 'null or a { module, export } ref')
    keys.resolver = {
      module: moduleLocation(loader.resolver.module, 'loader.resolver.module'),
      export: loader.resolver.export,
    }
  }
  return keys
}

function loaderConfig(value: unknown): SerializedLoaderConfig {
  const loader = record(value, 'loader')
  const { tsconfig, typescript } = loader
  if (tsconfig !== 'auto' && tsconfig !== false) {
    if (typeof tsconfig !== 'string')
      invalid('loader.tsconfig', "'auto', false or an absolute path")
    absolutePath(tsconfig, 'loader.tsconfig')
  }
  if (!TYPESCRIPT_MODES.includes(typescript)) {
    invalid('loader.typescript', "'oxc', 'node-strip' or 'off'")
  }
  return {
    ...resolverKeys(loader),
    hoist: hoistPolicy(loader.hoist),
    moduleScope: texts(loader.moduleScope, 'loader.moduleScope'),
    extensions: texts(loader.extensions, 'loader.extensions'),
    conditions: texts(loader.conditions, 'loader.conditions'),
    tsconfig,
    mappers: mapperList(loader.mappers),
    typescript: typescript as SerializedLoaderConfig['typescript'],
  }
}

/**
 * Checks `value` (a `WorkerInit.config`) and returns it as a `SerializedProjectConfig`. Throws
 * `ORCH_BAD_CONFIG` naming the first key that is missing or of the wrong kind.
 * @internal
 */
export function parseProjectConfig(value: unknown): SerializedProjectConfig {
  const config = record(value, 'config')
  if (typeof config.ci !== 'boolean') invalid('ci', 'a boolean')
  return {
    name: text(config.name, 'name'),
    rootDir: absolutePath(config.rootDir, 'rootDir'),
    ci: config.ci,
    policy: serializedPolicy(config.policy),
    environment: environmentRef(config.environment),
    globals: globalsRef(config.globals),
    moduleScope: moduleScopeRef(config.moduleScope),
    setupFiles: absolutePaths(config.setupFiles, 'setupFiles'),
    setupFilesAfterEnv: absolutePaths(config.setupFilesAfterEnv, 'setupFilesAfterEnv'),
    loader: loaderConfig(config.loader),
  }
}
