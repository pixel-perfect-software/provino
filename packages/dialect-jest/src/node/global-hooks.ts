// Jest's global hooks (T9.15) as the reader hands them on: which modules the run's own config
// names, and the two configs a hook is called with. A hook runs in the coordinator, so what it gets
// is Jest's own objects, not JSON: nothing here crosses to a worker.
import type { GlobalSetupArgs } from '@provino/types'
import { TestPathPatterns } from './internal/test-path-patterns.ts'
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

/** A hook's path as a list: `[path]`, or `[]` when the config names none. */
export function list(path: string | undefined): readonly string[] {
  return path === undefined ? [] : [path]
}

/**
 * The hooks the run itself names, beside its projects' own: the root config's `globalSetup` and
 * `globalTeardown`, which a config with `projects` keeps in its global config (`runGlobalHook` adds
 * them to the projects' own). Every path is absolute. `undefined` when the run names neither.
 * @public
 */
export function jestRunGlobalHooks(
  globalConfig: JestGlobalConfig,
): { readonly setup: readonly string[]; readonly teardown: readonly string[] } | undefined {
  const setup = list(globalConfig.globalSetup)
  const teardown = list(globalConfig.globalTeardown)
  return setup.length === 0 && teardown.length === 0 ? undefined : { setup, teardown }
}

/** The global config each read hands its hooks, built once: Jest passes one to every hook. */
const hookGlobalConfigs = new WeakMap<JestGlobalConfig, object>()

/**
 * What `fn(globalConfig, projectConfig)` receives for `project`: Jest's normalized project config
 * as it is, and the run's global config with `testPathPatterns` as the `TestPathPatterns` object
 * Jest 30 passes (the reader keeps the patterns as a list). The global config is built once per
 * read, so every project, and the setup and the teardown, share one.
 */
export function jestHookArgs(
  project: JestProjectConfig,
  globalConfig: JestGlobalConfig,
): GlobalSetupArgs {
  let hookConfig = hookGlobalConfigs.get(globalConfig)
  if (hookConfig === undefined) {
    hookConfig = {
      ...globalConfig,
      testPathPatterns: new TestPathPatterns([...globalConfig.testPathPatterns]),
    }
    hookGlobalConfigs.set(globalConfig, hookConfig)
  }
  return { globalConfig: hookConfig, projectConfig: project }
}
