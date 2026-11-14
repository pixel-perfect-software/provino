// `--debug` (jest-core `lib/logDebugMessages.ts`, Jest 30.5.2): the config as JSON, before the run.
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

/**
 * The text `--debug` (and `--showConfig`) prints: `{ configs, globalConfig, version }` with two
 * spaces of indent and a newline. The global config's `testPathPatterns` is the list of patterns
 * (as Jest's `.patterns`), which is what the reader already keeps.
 * @public
 */
export function jestDebugText(
  globalConfig: JestGlobalConfig,
  configs: readonly JestProjectConfig[],
  version: string,
): string {
  return `${JSON.stringify({ configs, globalConfig, version }, null, '  ')}\n`
}
