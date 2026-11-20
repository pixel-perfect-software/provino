// @provino/dialect-vitest/runtime: what the Vitest dialect runs in the worker: its behaviours,
// its globals and `vi` (`vitestGlobals`, `vitestModuleScope`), the matcher table and printer.
export { formatEachTitle } from '../each/format-each-title.ts'
export { vitestEnvironmentConditions } from './environment-conditions.ts'
export { VitestDialectError, type VitestDialectErrorCode } from './errors.ts'
export { vitestExpectTable, vitestShapeTestError } from './expect-table.ts'
export { expectTypeOf } from './expect-type-of.ts'
export { vitestFixtureMessages } from './fixture-messages.ts'
export {
  type VitestGlobals,
  vitestGlobals,
  vitestModuleScope,
} from './globals.ts'
export { vitestSnapshotPrinter } from './snapshot-printer.ts'
export type {
  VitestFakeTimersConfig,
  VitestGlobalsHost,
  VitestMockOptions,
  VitestObject,
  VitestRuntimeOptions,
  VitestWaitOptions,
  VitestWhen,
  VitestWhenCalledWith,
} from './vi.ts'
export {
  fromVitestEnvironment,
  type VitestEnvironmentLike,
  type VitestEnvironmentOptions,
  type VitestEnvironmentReturn,
  vitestEnvironment,
  vitestEnvironmentFor,
  vitestJsdomEnvironment,
} from './vitest-environment.ts'
