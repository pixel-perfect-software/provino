// B23c Phase 1: the contracts of changed-file and affected-test selection.
import type {
  AffectedSelection,
  ChangedFiles,
  ChangedFilesOptions,
  ChangedFilesProvider,
  CloneSafe,
  DependencyExtractor,
  FileJob,
  Loader,
  ModuleRef,
  NeutralProject,
  OrchestratorPolicy,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The shapes
expectTypeOf<ChangedFilesProvider>().toEqualTypeOf<
  (options: ChangedFilesOptions) => Promise<ChangedFiles>
>()
expectTypeOf<ChangedFiles['repos']>().toEqualTypeOf<{
  readonly git: readonly string[]
  readonly hg: readonly string[]
  readonly sl: readonly string[]
}>()
expectTypeOf<ChangedFilesOptions['roots']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<DependencyExtractor['extract']>().parameters.toEqualTypeOf<
  [string, string, (code: string) => Iterable<string>]
>()
declare const changed: ChangedFiles
const related: AffectedSelection = { kind: 'related', paths: ['/a.ts'] }
const byChange: AffectedSelection = { kind: 'changed', changed }
expectTypeOf(related).toExtend<AffectedSelection>()
expectTypeOf(byChange).toExtend<AffectedSelection>()
// @ts-expect-error a related selection names its paths
const noPaths: AffectedSelection = { kind: 'related' }

// The policy keys
declare const orchestrator: OrchestratorPolicy
expectTypeOf(orchestrator.affected.graph).toEqualTypeOf<'static' | 'recorded-then-static'>()
expectTypeOf(orchestrator.affected.invalidateAll).toEqualTypeOf<'project-inputs' | 'none'>()
// @ts-expect-error the graph is `static` or `recorded-then-static`
const badGraph: OrchestratorPolicy['affected']['graph'] = 'recorded'

// What crosses to a worker stays clone-safe
expectTypeOf<NonNullable<FileJob['staleModules']>>().toEqualTypeOf<readonly string[]>()
expectTypeOf<FileJob>().toExtend<CloneSafe<FileJob>>()
// @ts-expect-error a function can't be a stale module
const fnStale: FileJob = { ...({} as FileJob), staleModules: [() => 1] }
// @ts-expect-error with exactOptionalPropertyTypes, absent is not `undefined`
const undefStale: FileJob = { ...({} as FileJob), staleModules: undefined }

// The loader
expectTypeOf<Loader['dropRecords']>().toEqualTypeOf<(paths: readonly string[]) => void>()

// The project's own settings
expectTypeOf<NeutralProject['watch']>().toEqualTypeOf<
  { readonly ignorePatterns: readonly string[] } | undefined
>()
expectTypeOf<NonNullable<NeutralProject['affected']>['extractor']>().toEqualTypeOf<
  ModuleRef | undefined
>()

void [noPaths, badGraph, fnStale, undefStale]
