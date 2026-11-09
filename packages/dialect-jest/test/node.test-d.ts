// The public API of @provino/dialect-jest/node (B14b): the Jest config reader and `jestNodeDialect`.
import {
  createJestConfigReader,
  findJestConfig,
  type JestArgv,
  JestCliError,
  type JestCliErrorCode,
  type JestCliSupport,
  JestConfigError,
  type JestConfigErrorCode,
  type JestGlobalConfig,
  type JestLoadedConfig,
  type JestProjectConfig,
  type JestReadOutcome,
  type JestResolvedConfig,
  type JestTransformEntry,
  jestArgvToRunRequest,
  jestCli,
  jestConfigReader,
  jestFlags,
  jestNodeDialect,
  jestProjectToNeutral,
  loadJestConfig,
  parseJestArgv,
  parseJestCli,
  readJestConfig,
  readJestConfigs,
  resolveJestConfigPath,
} from '@provino/dialect-jest/node'
import type {
  CliDialect,
  ConfigReader,
  ConfigReadOutcome,
  ConfigSource,
  Diagnostic,
  Dialect,
  FlagSpec,
  NeutralProject,
  RunRequest,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The reader is a `ConfigReader` of its own shapes, and a plain one.
expectTypeOf(jestConfigReader).toEqualTypeOf<ConfigReader<JestLoadedConfig, JestResolvedConfig>>()
expectTypeOf(jestConfigReader).toExtend<ConfigReader>()
expectTypeOf(createJestConfigReader).returns.toEqualTypeOf<
  ConfigReader<JestLoadedConfig, JestResolvedConfig>
>()
expectTypeOf(jestConfigReader.find).returns.toEqualTypeOf<Promise<ConfigSource | undefined>>()
expectTypeOf(jestConfigReader.toNeutral).returns.toEqualTypeOf<
  ConfigReadOutcome<readonly NeutralProject[]>
>()
// @ts-expect-error resolve takes what load returned, not a path
void jestConfigReader.resolve('/repo/jest.config.js', { kind: 'file', path: '/repo' })

// The dialect with its reader is still a Jest dialect.
expectTypeOf(jestNodeDialect).toEqualTypeOf<Dialect<'jest'>>()
expectTypeOf(jestNodeDialect.configReader).toEqualTypeOf<ConfigReader | undefined>()

// Finding and loading.
expectTypeOf(findJestConfig).toEqualTypeOf<(cwd: string, explicit?: string) => ConfigSource>()
expectTypeOf(resolveJestConfigPath).returns.toEqualTypeOf<string>()
expectTypeOf(loadJestConfig).returns.toEqualTypeOf<
  Promise<{
    readonly options: Readonly<Record<string, unknown>>
    readonly configPath: string | null
  }>
>()
// @ts-expect-error an inline source needs its text
void loadJestConfig({ kind: 'inline', path: '/repo' })

// Reading and normalizing.
expectTypeOf(readJestConfig).returns.toEqualTypeOf<Promise<JestReadOutcome>>()
expectTypeOf<JestReadOutcome['projectConfig']>().toEqualTypeOf<JestProjectConfig>()
expectTypeOf<JestReadOutcome['globalConfig']>().toEqualTypeOf<JestGlobalConfig>()
expectTypeOf<JestReadOutcome['diagnostics']>().toEqualTypeOf<readonly Diagnostic[]>()
expectTypeOf(readJestConfigs).parameter(0).toEqualTypeOf<readonly string[]>()
expectTypeOf<JestProjectConfig['transform']>().toEqualTypeOf<readonly JestTransformEntry[]>()
expectTypeOf<JestProjectConfig['displayName']>().toEqualTypeOf<
  { readonly name: string; readonly color: string } | undefined
>()
declare const project: JestProjectConfig
// @ts-expect-error a normalized config is read-only
project.rootDir = '/x'

// The neutral project.
expectTypeOf(jestProjectToNeutral).returns.toEqualTypeOf<{
  readonly project: NeutralProject
  readonly diagnostics: readonly Diagnostic[]
}>()

// Errors carry a code.
expectTypeOf<JestConfigError['code']>().toEqualTypeOf<JestConfigErrorCode>()
// @ts-expect-error not a Jest config error code
void new JestConfigError('CONFIG_INVALID', 'x')

// The command line (T11.7, B14c): Jest's flags into Jest's own argv, and into a neutral request.
expectTypeOf(parseJestArgv).parameters.toEqualTypeOf<[args: readonly string[]]>()
expectTypeOf(parseJestArgv).returns.toEqualTypeOf<JestArgv>()
expectTypeOf(parseJestCli).returns.toEqualTypeOf<{
  readonly argv: JestArgv
  readonly diagnostics: Diagnostic[]
}>()
expectTypeOf(jestArgvToRunRequest).parameters.toEqualTypeOf<[argv: JestArgv]>()
expectTypeOf(jestArgvToRunRequest).returns.toEqualTypeOf<RunRequest>()
expectTypeOf(jestCli).toEqualTypeOf<CliDialect<JestArgv>>()
expectTypeOf(jestFlags).toEqualTypeOf<readonly FlagSpec[]>()
expectTypeOf(jestNodeDialect.cli).toEqualTypeOf<CliDialect | undefined>()
// @ts-expect-error the arguments are strings
void parseJestArgv([1, 2])
// @ts-expect-error the parser takes the arguments after the command name, not a string
void parseJestArgv('--ci')

// A refusal carries a code, so a caller maps it to an exit code without reading its text.
expectTypeOf<JestCliError['code']>().toEqualTypeOf<JestCliErrorCode>()
expectTypeOf<JestCliSupport>().toEqualTypeOf<
  'request' | 'config' | 'accepted' | 'warn' | 'refuse'
>()
// @ts-expect-error not a Jest CLI error code
void new JestCliError('CONFIG_INVALID', 'x')
