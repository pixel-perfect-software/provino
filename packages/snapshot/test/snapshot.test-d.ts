// The public API of @provino/snapshot, through its three entries.
import {
  checkSnapHeader,
  deepMerge,
  defaultSnapshotPath,
  evaluateSnapFile,
  keyToTestName,
  naturalCompare,
  SnapshotError,
  type SnapshotErrorCode,
  type SnapshotUpdateMode,
  serializeSnapFile,
} from '@provino/snapshot'
import {
  createSnapshotAggregate,
  resolveUpdateMode,
  snapshotRunFails,
} from '@provino/snapshot/node'
import {
  type MatchOptions,
  type MatchResult,
  openFileSnapshots,
  type SnapshotLifecycle,
  SnapshotState,
  type SnapshotStateOptions,
  trackSnapshots,
} from '@provino/snapshot/runtime'
import type {
  SnapshotFileReport,
  SnapshotPolicy,
  SnapshotPrinter,
  SnapshotRunSummary,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The format.
expectTypeOf(serializeSnapFile({ 'a 1': 'x' }, '// header')).toEqualTypeOf<string>()
expectTypeOf(evaluateSnapFile('')).toEqualTypeOf<Record<string, string>>()
expectTypeOf(checkSnapHeader('', '')).toEqualTypeOf<string | null>()
expectTypeOf(keyToTestName('a 1')).toEqualTypeOf<string>()
expectTypeOf(naturalCompare('a', 'b')).toEqualTypeOf<number>()
expectTypeOf(deepMerge({}, {})).toEqualTypeOf<unknown>()
expectTypeOf(
  defaultSnapshotPath('/a.test.ts', { dirName: 'd', extension: '.s' }),
).toEqualTypeOf<string>()
// @ts-expect-error the data is strings by key
serializeSnapFile({ 'a 1': 1 }, '// header')
// @ts-expect-error the layout needs both parts
defaultSnapshotPath('/a.test.ts', { dirName: 'd' })

// The modes and the errors.
expectTypeOf<SnapshotUpdateMode>().toEqualTypeOf<'all' | 'new' | 'none'>()
expectTypeOf<SnapshotError['code']>().toEqualTypeOf<SnapshotErrorCode>()
// @ts-expect-error not a code
new SnapshotError('SNAPSHOT_NO_SUCH_CODE', 'message')

// The coordinator side.
expectTypeOf(
  resolveUpdateMode({
    update: false,
    ci: true,
    env: {},
    policy: { ciUpdate: 'none', updateEnvVar: null },
  }),
).toEqualTypeOf<SnapshotUpdateMode>()
const rewritesInCi = { ciUpdate: 'all', updateEnvVar: null } as const
// @ts-expect-error CI is `new` or `none`, never `all`
resolveUpdateMode({ update: false, ci: true, env: {}, policy: rewritesInCi })
const aggregate = createSnapshotAggregate()
expectTypeOf(aggregate.summary('new')).toEqualTypeOf<SnapshotRunSummary | undefined>()
expectTypeOf(aggregate.add).parameters.toEqualTypeOf<[SnapshotFileReport, string]>()
expectTypeOf(
  snapshotRunFails(undefined, { obsolete: { failLocal: true, failCI: true } }),
).toEqualTypeOf<boolean>()
// @ts-expect-error the rule needs both modes
snapshotRunFails(undefined, { obsolete: { failLocal: true } })

// The worker side.
declare const options: SnapshotStateOptions
expectTypeOf(options.update).toEqualTypeOf<SnapshotUpdateMode>()
expectTypeOf(options.printer).toEqualTypeOf<SnapshotPrinter>()
expectTypeOf(options.policy).toMatchTypeOf<Pick<SnapshotPolicy, 'header' | 'format'>>()
declare const state: SnapshotState
expectTypeOf(state.match).parameters.toEqualTypeOf<[MatchOptions]>()
expectTypeOf(state.match).returns.toEqualTypeOf<MatchResult>()
expectTypeOf(state.finish()).toEqualTypeOf<SnapshotFileReport>()
expectTypeOf(state.testName(['a'], 'hint')).toEqualTypeOf<string>()
// @ts-expect-error a match needs the received value and whether it is inline
state.match({ testName: 't' })
// @ts-expect-error an unknown update mode
new SnapshotState({ ...options, update: 'sometimes' })
declare const life: SnapshotLifecycle
expectTypeOf(life.finish()).toEqualTypeOf<SnapshotFileReport | null>()
expectTypeOf(trackSnapshots(state, { keyJoin: ' ' })).toEqualTypeOf<SnapshotLifecycle>()
// @ts-expect-error the lifecycle needs the key join
trackSnapshots(state, {})
expectTypeOf(openFileSnapshots).returns.toEqualTypeOf<{
  readonly state: SnapshotState
  readonly lifecycle: SnapshotLifecycle
}>()
