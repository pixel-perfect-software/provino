import type {
  BenchLabel,
  BenchRecord,
  IsolationMode,
  IsolationTier,
  NormalizedRun,
  NormalizedTest,
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
