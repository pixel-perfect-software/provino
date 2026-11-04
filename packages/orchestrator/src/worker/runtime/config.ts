// The project config arrives in `WorkerInit` typed, but it crossed a link: the worker checks that
// every piece it reads is there before it builds anything, so a malformed config fails with a code
// and the name of the key, instead of a `TypeError` from the middle of the boot. Leaf values of
// the policy are checked where they are used (behaviour keys by the behaviour loader).
import { isModuleRef, neutralPolicy } from '@provino/policy'
import type {
  EnvironmentRef,
  GlobalsFactory,
  ModuleRef,
  SerializedLoaderConfig,
  SerializedPolicy,
  SerializedProjectConfig,
} from '@provino/types'
import { WorkerError } from '../errors.ts'

const TYPESCRIPT_MODES: readonly unknown[] = ['oxc', 'node-strip', 'off']

function invalid(path: string, expected: string): never {
  throw new WorkerError(
    'ORCH_BAD_CONFIG',
    `The project config is invalid: ${path} must be ${expected}`,
  )
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : invalid(path, 'an object')
}

function text(value: unknown, path: string): string {
  return typeof value === 'string' ? value : invalid(path, 'a string')
}

function texts(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return invalid(path, 'an array of strings')
  }
  return value
}

/** Every slice of the policy is there as an object: the shape `SerializedPolicy` promises. */
function isSerializedPolicy(value: unknown): value is SerializedPolicy {
  return isRecord(value) && Object.keys(neutralPolicy).every((slice) => isRecord(value[slice]))
}

function serializedPolicy(value: unknown): SerializedPolicy {
  const policy = record(value, 'policy')
  for (const slice of Object.keys(neutralPolicy)) record(policy[slice], `policy.${slice}`)
  return isSerializedPolicy(policy) ? policy : invalid('policy', 'an object with every slice')
}

function isGlobalsRef(value: unknown): value is ModuleRef<GlobalsFactory> {
  return isModuleRef(value)
}

function environmentRef(value: unknown): EnvironmentRef {
  const ref = record(value, 'environment')
  return {
    module: text(ref.module, 'environment.module'),
    export: text(ref.export, 'environment.export'),
    options: record(ref.options, 'environment.options') as EnvironmentRef['options'],
  }
}

function loaderConfig(value: unknown): SerializedLoaderConfig {
  const loader = record(value, 'loader')
  const { tsconfig, mappers, typescript } = loader
  if (tsconfig !== 'auto' && tsconfig !== false && typeof tsconfig !== 'string') {
    invalid('loader.tsconfig', "'auto', false or a path")
  }
  if (!Array.isArray(mappers)) invalid('loader.mappers', 'an array')
  if (!TYPESCRIPT_MODES.includes(typescript)) {
    invalid('loader.typescript', "'oxc', 'node-strip' or 'off'")
  }
  return {
    extensions: texts(loader.extensions, 'loader.extensions'),
    conditions: texts(loader.conditions, 'loader.conditions'),
    tsconfig,
    mappers,
    typescript: typescript as SerializedLoaderConfig['typescript'],
  }
}

/**
 * Checks `value` (a `WorkerInit.config`) and returns it as a `SerializedProjectConfig`. Throws
 * `ORCH_BAD_CONFIG` naming the first key that is missing or of the wrong kind.
 */
export function parseProjectConfig(value: unknown): SerializedProjectConfig {
  const config = record(value, 'config')
  if (typeof config.ci !== 'boolean') invalid('ci', 'a boolean')
  const globals = config.globals
  if (globals !== null && !isGlobalsRef(globals)) {
    invalid('globals', 'null or a { module, export } ref')
  }
  return {
    name: text(config.name, 'name'),
    rootDir: text(config.rootDir, 'rootDir'),
    ci: config.ci,
    policy: serializedPolicy(config.policy),
    environment: environmentRef(config.environment),
    globals,
    setupFiles: texts(config.setupFiles, 'setupFiles'),
    setupFilesAfterEnv: texts(config.setupFilesAfterEnv, 'setupFilesAfterEnv'),
    loader: loaderConfig(config.loader),
  }
}
