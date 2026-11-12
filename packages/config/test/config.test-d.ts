// The public API of @provino/config.
import {
  ConfigError,
  type ConfigErrorCode,
  type ConfigIssue,
  formatConfigIssue,
  importConfigModule,
  loadConfigFile,
  loadProject,
  pruneTransformCache,
  type ResolvedProject,
  type ResolveNeutralProjectOptions,
  type ResolveProjectOptions,
  resolveNeutralProject,
  resolveProject,
  withTransformCache,
} from '@provino/config'
import type {
  ConfigEnv,
  Dialect,
  IsolationTier,
  NeutralDiscovery,
  NeutralProject,
  Policy,
  ProvinoConfigInput,
  SerializedProjectConfig,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

expectTypeOf(importConfigModule).toEqualTypeOf<
  (path: string, options?: { readonly withoutDefault?: 'error' | 'namespace' }) => Promise<unknown>
>()
// @ts-expect-error not a way to treat a module with no default export
void importConfigModule('/x.js', { withoutDefault: 'first-export' })
expectTypeOf(resolveNeutralProject).toEqualTypeOf<
  (neutral: NeutralProject, options: ResolveNeutralProjectOptions) => Promise<ResolvedProject>
>()
expectTypeOf<ResolveNeutralProjectOptions['dialect']>().toEqualTypeOf<Dialect | null>()
expectTypeOf<ResolvedProject['discovery']>().toEqualTypeOf<NeutralDiscovery | null>()
const partial = { name: '', rootDir: '/' }
// @ts-expect-error a neutral project needs its discovery rules
void resolveNeutralProject(partial, { dialect: null, environments: {}, ci: false })

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

expectTypeOf(formatConfigIssue).toEqualTypeOf<(issue: ConfigIssue) => string>()
// @ts-expect-error an issue is { path, message }, not a string
formatConfigIssue('path: message')

// T3.6: the transform cache's coordinator half.
expectTypeOf(withTransformCache).toEqualTypeOf<
  (project: ResolvedProject, dir: string) => ResolvedProject
>()
expectTypeOf(pruneTransformCache).toEqualTypeOf<(dir: string) => void>()
// @ts-expect-error the directory is a string
pruneTransformCache(undefined)
