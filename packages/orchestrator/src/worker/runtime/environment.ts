// Loading the test environment by ref (the worker may not import an environment package), and
// checking what comes back before anything is set up with it.
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  Environment,
  EnvironmentInstance,
  EnvironmentRef,
  EnvironmentSetupContext,
} from '@provino/types'
import { WorkerError } from '../errors.ts'

/** The environment's options, as the config carries them. */
export type EnvironmentOptions = EnvironmentRef['options']

/** A loaded environment and what its `prepare` returned. */
export interface PreparedEnvironment {
  readonly environment: Environment<string, EnvironmentOptions>
  readonly options: EnvironmentOptions
  /** What `prepare(options)` returned: the second argument of every `setup`. */
  readonly prepared: unknown
}

function bad(ref: EnvironmentRef, problem: string, options?: ErrorOptions): WorkerError {
  return new WorkerError(
    'ORCH_BAD_ENVIRONMENT',
    `The environment ${ref.module}#${ref.export} ${problem}`,
    options,
  )
}

function isEnvironment(value: unknown): value is Environment<string, EnvironmentOptions> {
  if (typeof value !== 'object' || value === null) return false
  const { name, realms, setup, prepare } = value as Record<string, unknown>
  return (
    typeof name === 'string' &&
    Array.isArray(realms) &&
    typeof setup === 'function' &&
    (prepare === undefined || typeof prepare === 'function')
  )
}

/**
 * Imports the module `ref` names and reads its export. The export must be an `Environment` whose
 * `realms` include `'worker'` (a `context`-only environment needs the `realm` tier, which no
 * worker runs yet). Throws `ORCH_BAD_ENVIRONMENT` otherwise.
 */
export async function importEnvironment(
  ref: EnvironmentRef,
): Promise<Environment<string, EnvironmentOptions>> {
  let namespace: Readonly<Record<string, unknown>>
  try {
    namespace = await import(isAbsolute(ref.module) ? pathToFileURL(ref.module).href : ref.module)
  } catch (cause) {
    throw bad(ref, "can't be imported", { cause })
  }
  const environment = namespace[ref.export]
  if (!isEnvironment(environment)) {
    throw bad(
      ref,
      'is not an environment: it needs a name, a realms array, a setup function and, if it has one, a prepare function',
    )
  }
  if (!environment.realms.includes('worker')) {
    throw bad(
      ref,
      `supports the realms ${JSON.stringify(environment.realms)}, not 'worker'; the worker runs files in its own realm`,
    )
  }
  return environment
}

/**
 * Loads the environment `ref` names and calls its `prepare` once (an environment that has none
 * prepares to `undefined`).
 */
export async function prepareEnvironment(ref: EnvironmentRef): Promise<PreparedEnvironment> {
  const environment = await importEnvironment(ref)
  const prepared: unknown = await environment.prepare?.(ref.options)
  return { environment, options: ref.options, prepared }
}

function isInstance(value: unknown): value is EnvironmentInstance {
  if (typeof value !== 'object' || value === null) return false
  const { global, teardown } = value as Record<string, unknown>
  return typeof global === 'object' && global !== null && typeof teardown === 'function'
}

/**
 * Sets the environment up for one file (scope `file`) or for the worker (scope `worker`), and
 * checks the instance: a `global` object to install into and a `teardown` function to call.
 * Throws `ORCH_BAD_ENVIRONMENT` for one without.
 */
export async function setupEnvironment(
  loaded: PreparedEnvironment,
  context: Omit<EnvironmentSetupContext<EnvironmentOptions>, 'options' | 'realm'>,
): Promise<EnvironmentInstance> {
  const instance = await loaded.environment.setup(
    { ...context, options: loaded.options, realm: 'worker' },
    loaded.prepared,
  )
  if (!isInstance(instance)) {
    throw new WorkerError(
      'ORCH_BAD_ENVIRONMENT',
      `The environment "${loaded.environment.name}" returned an instance without a global object and a teardown function`,
    )
  }
  return instance
}
