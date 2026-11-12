// A dialect command line's contract (B14c, T11.7): `RunRequest`, `FileFilter` and `CliDialect`.
import type { CliDialect, Diagnostic, Dialect, FileFilter, RunRequest } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// A request has a mode, the file filters and the flags every run reads; the rest is optional, so a
// project's own settings stand when the command line is silent.
expectTypeOf<RunRequest['mode']>().toEqualTypeOf<
  'run' | 'list-files' | 'show-config' | 'clear-cache'
>()
expectTypeOf<RunRequest['fileFilters']>().toEqualTypeOf<readonly FileFilter[]>()
expectTypeOf<RunRequest['ci']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<RunRequest['update']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<RunRequest['maxWorkers']>().toEqualTypeOf<number | `${number}%` | undefined>()

const minimal: RunRequest = { mode: 'run', json: false, fileFilters: [], inBand: false }
void minimal
// @ts-expect-error a request says what it asks for: the mode is required
const noMode: RunRequest = { json: false, fileFilters: [], inBand: false }
void noMode
// @ts-expect-error a mode that no runner has
const badMode: RunRequest = { mode: 'watch', json: false, fileFilters: [], inBand: false }
void badMode
// @ts-expect-error a percentage is a number followed by a percent sign
const badWorkers: RunRequest = { ...minimal, maxWorkers: 'all' }
void badWorkers

// T9.10: the lifecycle flags. A bail is a count in an object; the other two are switches.
expectTypeOf<RunRequest['bail']>().toEqualTypeOf<{ readonly count: number } | undefined>()
expectTypeOf<RunRequest['forceExit']>().toEqualTypeOf<boolean | undefined>()
expectTypeOf<RunRequest['detectOpenHandles']>().toEqualTypeOf<boolean | undefined>()
// @ts-expect-error a bail is `{ count }`, not a bare number
const badBail: RunRequest = { ...minimal, bail: 2 }
void badBail

// A filter is a kind and a value; a `file.ts:12` filter carries its line.
expectTypeOf<{ kind: 'regex'; value: string }>().toExtend<FileFilter>()
expectTypeOf<{ kind: 'pathLine'; value: string; line: number }>().toExtend<FileFilter>()
// @ts-expect-error not a filter kind
const badKind: FileFilter = { kind: 'glob', value: 'a' }
void badKind

// A dialect's command line parses to its own argv and turns that into a request.
interface FakeArgv {
  readonly patterns: readonly string[]
}
declare const cli: CliDialect<FakeArgv>
expectTypeOf(cli.parse).returns.toEqualTypeOf<{
  readonly argv: FakeArgv
  readonly diagnostics: readonly Diagnostic[]
}>()
expectTypeOf(cli.toRunRequest).returns.toEqualTypeOf<RunRequest>()
// A command line of its own argv type is still a `CliDialect`, so a dialect can hold it.
expectTypeOf(cli).toExtend<CliDialect>()
expectTypeOf<{
  readonly name: 'x'
  readonly version: '1'
  readonly policy: object
  readonly cli: typeof cli
}>().toExtend<Dialect<'x'>>()
