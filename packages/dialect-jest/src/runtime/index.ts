// @provino/dialect-jest/runtime: what the Jest dialect runs in the worker. B08 has the expect
// table, B10 the globals (`describe`, `it`, the hooks, `expect` and a minimal `jest`); the full
// `jest` object, the facades and the behaviour functions come with T1.8, T11.10 and B13 (B14, B17).
export { jestExpectTable } from './expect-table.ts'
export {
  type JestGlobals,
  type JestGlobalsHost,
  type JestMockOptions,
  type JestModuleObject,
  type JestObject,
  jestGlobals,
  jestModuleScope,
} from './globals.ts'
