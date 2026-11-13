// B23b Phase 1: the coverage config and events cross threads, so they are CloneSafe, and the
// misuse a user could make is a type error.
import type {
  CloneSafe,
  CoverageInstrumenter,
  CoveragePolicy,
  CoverageThresholdGroup,
  IstanbulFileCoverageData,
  RunCoverageOptions,
  SerializedCoverageConfig,
  SerializedProjectConfig,
  TaskId,
  WorkerEvent,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The config and the data that cross are CloneSafe.
expectTypeOf<SerializedCoverageConfig>().toExtend<CloneSafe<SerializedCoverageConfig>>()
expectTypeOf<RunCoverageOptions>().toExtend<CloneSafe<RunCoverageOptions>>()
expectTypeOf<IstanbulFileCoverageData>().toExtend<CloneSafe<IstanbulFileCoverageData>>()
expectTypeOf<SerializedProjectConfig['coverage']>().toEqualTypeOf<
  SerializedCoverageConfig | undefined
>()

const config: SerializedCoverageConfig = {
  provider: 'istanbul',
  root: '/repo',
  include: ['src/**/*.ts'],
  includeRoot: true,
  force: [],
  testFiles: [],
  excludePatterns: [],
  excludePaths: [],
}
export const withMatcher: SerializedCoverageConfig = {
  ...config,
  // @ts-expect-error a function does not cross threads: behaviour reaches a worker as the injected instrumenter
  excludePatterns: [(file: string) => file.endsWith('.d.ts')],
}

// The instrumenter may return the file's initial coverage.
declare const instrumenter: CoverageInstrumenter
expectTypeOf(instrumenter.instrument('', '', null).coverage).toEqualTypeOf<
  IstanbulFileCoverageData | undefined
>()

// A worker's data taken once at the end has no file: `null`, never `undefined`.
type CoverageEvent = Extract<WorkerEvent, { type: 'coverage' }>
expectTypeOf<CoverageEvent['fileId']>().toEqualTypeOf<TaskId | null>()
export const noFile: Pick<CoverageEvent, 'fileId'> = { fileId: null }
// @ts-expect-error `exactOptionalPropertyTypes` and a required key: `undefined` is not `null`
export const undefinedFile: Pick<CoverageEvent, 'fileId'> = { fileId: undefined }

// The V8 converter is one of two names.
export const ast: CoveragePolicy['v8Conversion'] = 'ast'
// @ts-expect-error `legacy` is not a converter
export const legacy: CoveragePolicy['v8Conversion'] = 'legacy'

// A threshold group has a name.
export const group: CoverageThresholdGroup = { name: 'global', lines: 80 }
// @ts-expect-error a group without a name
export const unnamed: CoverageThresholdGroup = { lines: 80 }
