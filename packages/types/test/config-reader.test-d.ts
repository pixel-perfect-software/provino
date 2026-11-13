// Track 11's config reader contract (B14b): `ConfigReader`, `ConfigSource` and `NeutralProject`.
import type {
  CloneSafe,
  ConfigReader,
  ConfigReadOutcome,
  ConfigSource,
  Dialect,
  JsonValue,
  NeutralProject,
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

// What a global setup or teardown is called with (T9.15): two configs as JSON, so they cross to
// a worker, and absent when the project has no hooks.
expectTypeOf<NeutralProject['globalSetup']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<NonNullable<NeutralProject['globalSetupArgs']>['globalConfig']>().toExtend<
  Readonly<Record<string, JsonValue>>
>()
expectTypeOf<NonNullable<NeutralProject['globalSetupArgs']>['projectConfig']>().toExtend<
  Readonly<Record<string, JsonValue>>
>()
const hookArgs: NeutralProject['globalSetupArgs'] = {
  // @ts-expect-error a global config is JSON: no function in it
  globalConfig: { f: () => 1 },
  projectConfig: {},
}
void hookArgs
