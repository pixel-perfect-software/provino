import type {
  BenchLabel,
  BenchRecord,
  IsolationMode,
  IsolationTier,
  NormalizedRun,
  NormalizedTest,
  RunRef,
  SchemaVersion,
  TestStatus,
  WallStats,
} from '@provino/types'
import { expectTypeOf } from 'expect-type'

// The result model (Track 12 §Types).
expectTypeOf<TestStatus>().toEqualTypeOf<'passed' | 'failed' | 'skipped' | 'todo' | 'notRun'>()
expectTypeOf<NormalizedTest['id']['path']>().toEqualTypeOf<readonly string[]>()
expectTypeOf<NormalizedRun['schemaVersion']>().toEqualTypeOf<SchemaVersion>()
expectTypeOf<SchemaVersion>().toEqualTypeOf<1>()

// Optional fields reject explicit undefined under exactOptionalPropertyTypes (TS2375).
// @ts-expect-error passingAssertions is optional, not undefined
const bad: NormalizedTest = {
  id: { file: 'a', path: ['x'], dupIndex: 0 },
  status: 'passed',
  errors: [],
  passingAssertions: undefined,
}
void bad

// @ts-expect-error 'pending' is a runner word; the model says 'notRun'
const pending: TestStatus = 'pending'
void pending

// Bench records carry a label, and only these three (.claude/rules/benchmarks.md).
expectTypeOf<BenchRecord['label']>().toEqualTypeOf<BenchLabel>()
expectTypeOf<BenchLabel>().toEqualTypeOf<'local' | 'desktop' | 'pinned'>()
// @ts-expect-error 'ci' is not a bench label
const ci: BenchLabel = 'ci'
void ci

// Isolation reuses Provino's tiers.
expectTypeOf<IsolationMode>().toEqualTypeOf<IsolationTier | 'runner-default'>()
expectTypeOf<WallStats['samplesMs']>().toEqualTypeOf<readonly number[]>()

// A run ref says whether the working tree was dirty when the bench started, so a record can never
// claim a commit it did not measure. The field is required, boolean and read-only.
expectTypeOf<RunRef['dirty']>().toEqualTypeOf<boolean>()
expectTypeOf<BenchRecord['ref']>().toEqualTypeOf<RunRef>()
// @ts-expect-error a run ref must say whether the tree was dirty
const undeclared: RunRef = { sha: 'a', date: '2026-11-02T00:00:00.000Z' }
void undeclared
declare const ref: RunRef
// @ts-expect-error a run ref is read-only
ref.dirty = true
