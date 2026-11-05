// The public API of @provino/config.
import {
  ConfigError,
  type ConfigErrorCode,
  type ConfigIssue,
  loadConfigFile,
  loadProject,
  type ResolvedProject,
  type ResolveProjectOptions,
  resolveProject,
} from '@provino/config'
import type {
  ConfigEnv,
  Dialect,
  IsolationTier,
  Policy,
  ProvinoConfigInput,
  SerializedProjectConfig,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(loadConfigFile).toEqualTypeOf<
  (path: string, env: ConfigEnv) => Promise<ProvinoConfigInput>
>()
expectTypeOf(resolveProject).toEqualTypeOf<
  (input: ProvinoConfigInput, options: ResolveProjectOptions) => Promise<ResolvedProject>
>()
expectTypeOf(loadProject).parameter(0).toEqualTypeOf<string>()
expectTypeOf(loadProject).returns.toEqualTypeOf<Promise<ResolvedProject>>()

expectTypeOf<ResolvedProject['dialect']>().toEqualTypeOf<Dialect | null>()
expectTypeOf<ResolvedProject['policy']>().toEqualTypeOf<Policy>()
expectTypeOf<ResolvedProject['isolation']>().toEqualTypeOf<IsolationTier>()
expectTypeOf<ResolvedProject['config']>().toEqualTypeOf<SerializedProjectConfig>()
expectTypeOf<ResolvedProject['include']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<ResolvedProject['environment']>().toEqualTypeOf<string>()

expectTypeOf<ConfigError['code']>().toEqualTypeOf<ConfigErrorCode>()
expectTypeOf<ConfigError['issues']>().toEqualTypeOf<readonly ConfigIssue[]>()
expectTypeOf<ConfigError>().toExtend<Error>()
expectTypeOf<ConfigErrorCode>().toEqualTypeOf<
  | 'CONFIG_LOAD_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_UNKNOWN_DIALECT'
  | 'CONFIG_DIALECT_TIE'
  | 'CONFIG_UNKNOWN_ENVIRONMENT'
  | 'CONFIG_UNSUPPORTED'
  | 'CONFIG_BAD_DIALECT_OPTIONS'
>()

// loadProject takes the resolve options without the config path, plus an optional env.
declare const options: Omit<ResolveProjectOptions, 'configPath'>
loadProject('/app/provino.config.mjs', options)
loadProject('/app/provino.config.mjs', { ...options, env: { command: 'watch', mode: 'dev' } })

// @ts-expect-error not a code
new ConfigError('CONFIG_NOPE', 'message')
// @ts-expect-error the code is read-only
new ConfigError('CONFIG_INVALID', 'message').code = 'CONFIG_UNSUPPORTED'
// @ts-expect-error the ConfigEnv command is 'run' or 'watch'
loadConfigFile('/app/provino.config.mjs', { command: 'build', mode: 'test' })
// @ts-expect-error the path is a string
loadConfigFile(3, { command: 'run', mode: 'test' })
// @ts-expect-error resolveProject needs its options
resolveProject({})
// @ts-expect-error the config path is required to resolve
resolveProject({}, { dialects: [], environments: {}, ci: false })
// @ts-expect-error `ci` is a boolean
resolveProject({}, { configPath: '/a', dialects: [], environments: {}, ci: 'no' })
const noExport = {
  configPath: '/a',
  dialects: [],
  environments: { node: { module: '/m' } },
  ci: false,
}
// @ts-expect-error an environment ref needs its export name
resolveProject({}, noExport)
const complete = { configPath: '/a', dialects: [], environments: {}, ci: false }
// @ts-expect-error isolation is one of the four tiers
resolveProject({ isolation: 'vm' }, complete)
// @ts-expect-error a resolved project is read-only
;(null as unknown as ResolvedProject).name = 'x'
// @ts-expect-error `configPath` is loadProject's first argument, not one of its options
loadProject('/a', { dialects: [], environments: {}, ci: false, configPath: '/a' })
