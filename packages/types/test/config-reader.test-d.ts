// Track 11's config reader contract (B14b): `ConfigReader`, `ConfigSource` and `NeutralProject`.
import type {
  Behaviour,
  CloneSafe,
  ConfigReader,
  ConfigReadOutcome,
  ConfigSource,
  Dialect,
  GlobalSetupArgs,
  GlobalSetupFailure,
  NeutralProject,
  OrchestratorPolicy,
  SerializedProjectConfig,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

interface RawA {
  readonly a: number
}
interface ResolvedA {
  readonly resolved: true
}

declare const typed: ConfigReader<RawA, ResolvedA>
// A reader of its own shapes is still a `ConfigReader` (the methods are bivariant), so a dialect
// can hold it.
expectTypeOf(typed).toExtend<ConfigReader>()
expectTypeOf<{
  readonly name: 'x'
  readonly version: '1'
  readonly policy: object
  readonly configReader: typeof typed
}>().toExtend<Dialect<'x'>>()
expectTypeOf(typed.load).returns.toEqualTypeOf<Promise<RawA>>()
expectTypeOf(typed.resolve).returns.toEqualTypeOf<Promise<ConfigReadOutcome<ResolvedA>>>()
expectTypeOf(typed.toNeutral).returns.toEqualTypeOf<ConfigReadOutcome<readonly NeutralProject[]>>()

// A source is a file, a package.json key, or inline text.
expectTypeOf<{ kind: 'file'; path: string }>().toExtend<ConfigSource>()
expectTypeOf<{ kind: 'inline'; path: string; text: string }>().toExtend<ConfigSource>()
// @ts-expect-error inline config carries its text
const inline: ConfigSource = { kind: 'inline', path: '/x' }
void inline
// @ts-expect-error not a source kind
const other: ConfigSource = { kind: 'url', path: '/x' }
void other

// A neutral project holds only data: it clones, as what is built from it crosses to a worker.
expectTypeOf<CloneSafe<NeutralProject>>().not.toBeNever()
expectTypeOf<NeutralProject['discovery']['includePatterns']['kind']>().toEqualTypeOf<
  'glob' | 'regex'
>()
expectTypeOf<NeutralProject['environment']['options']>().toExtend<
  SerializedProjectConfig['environment']['options']
>()
declare const project: NeutralProject
// The directory a user chose for caches (D70) is optional, and a plain string.
expectTypeOf<NeutralProject['cacheDirectory']>().toEqualTypeOf<string | undefined>()
// @ts-expect-error a pattern is a source, never a RegExp
const pattern: RegExp = project.aliases[0]?.pattern ?? /x/
void pattern

// What a global setup or teardown is called with (T9.15): the two configs the reader built. A hook
// runs in the coordinator, so they never cross to a worker: objects, not JSON. Absent when the
// project has no hooks.
expectTypeOf<NeutralProject['globalSetup']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<NeutralProject['globalSetupArgs']>().toEqualTypeOf<GlobalSetupArgs | undefined>()
expectTypeOf<GlobalSetupArgs['globalConfig']>().toEqualTypeOf<object>()
expectTypeOf<GlobalSetupArgs['projectConfig']>().toEqualTypeOf<object>()
// A function or a class instance in them is kept: nothing is lost to JSON on the way to a hook.
const hookArgs: GlobalSetupArgs = {
  globalConfig: { run: () => 1, patterns: new Map<string, string>() },
  projectConfig: {},
}
// @ts-expect-error a hook is given both configs
const oneConfig: GlobalSetupArgs = { globalConfig: {} }
// @ts-expect-error a config is an object, not text
const textConfig: GlobalSetupArgs = { globalConfig: 'rootDir', projectConfig: {} }
void hookArgs
void oneConfig
void textConfig

// What a hook that throws is reported as (T9.15): one behaviour, so a dialect gives it as a
// `ModuleRef`. It is given what was thrown, the hook and the module, and returns the error to report.
expectTypeOf<GlobalSetupFailure>().parameter(0).toEqualTypeOf<unknown>()
expectTypeOf<GlobalSetupFailure>()
  .parameter(1)
  .toEqualTypeOf<{ readonly hook: 'globalSetup' | 'globalTeardown'; readonly path: string }>()
expectTypeOf<GlobalSetupFailure>().returns.toEqualTypeOf<Error>()
expectTypeOf<OrchestratorPolicy['globalSetup']['failure']>().toEqualTypeOf<
  Behaviour<GlobalSetupFailure>
>()
// @ts-expect-error the error to report is an Error, not text
const reportedAsText: GlobalSetupFailure = (thrown) => String(thrown)
const unknownHook: GlobalSetupFailure = (_thrown, { hook }) => {
  // @ts-expect-error a hook is globalSetup or globalTeardown, not another name
  const isSetup = hook === 'setup'
  return new Error(isSetup ? 'a' : 'b')
}
void reportedAsText
void unknownHook
