// B23e Phase 2b (T11.11, T7.16): the matcher, mock and network packages a Jest project loads from
// its own node_modules, run through `provino jest` and held to what Jest 30.5.2 recorded for the
// same project (`ecosystem/*`): the exit code, the kept stderr lines and the whole results file.
// Each fixture has two test files under `-w 1`, so the second file runs in a worker that already
// loaded the package for the first.
import { describeRecorded } from './recorded-run.ts'

const FIXTURES = [
  ['ecosystem/identity-obj-proxy', "a CSS mapper and Babel's interop over __esModule: false"],
  ['ecosystem/expect-type', 'expect-type loads and its calls do nothing'],
  // Phase 2d (D127, P42): a package that reads `expect` or `jest` while it first loads in a
  // worker is evaluated again for each later file (`module.reevaluateHookingExternals`).
  ['ecosystem/jest-extended-all', "jest-extended/all's expect.extend, in both files"],
  ['ecosystem/jest-fetch-mock', "enableMocks()'s jest.fn, the second file's own"],
  // A package that asserts as it loads (jest-when's `expect().__capture_equals__()` at module scope)
  // is counted into the next test to end (`expect.outsideTestCounts`).
  ['ecosystem/jest-when', 'when(fn).calledWith: the load-time assertion goes to the first test'],
  // A shared package's own `require('@jest/globals')` gets the served module.
  ['ecosystem/jest-mock-extended', 'mock<T>() and calledWith over the served @jest/globals'],
  // B23f (D149 as amended): @mswjs/interceptors adds `__MSW_INTERNAL_CONNECTION_CONTEXT` to the
  // global as it loads, which the node environment's restore takes away after the first file; the
  // shared copy never adds it again, so msw's own passthrough sockets were caught as requests and
  // the second file's unhandled fetch looped. A load that writes the global is now a trigger too
  // (`module.reevaluatePatchingExternals`), so msw is evaluated per file from the second file on.
  ['ecosystem/msw-node', "the second file's server intercepts, and its unhandled fetch rejects"],
] as const

/** The seven fixtures Phase 2b records (other phases add `ecosystem/*` fixtures of their own). */
const PHASE_2B: ReadonlySet<string> = new Set([
  'ecosystem/jest-extended-all',
  'ecosystem/jest-mock-extended',
  'ecosystem/jest-when',
  'ecosystem/jest-fetch-mock',
  'ecosystem/msw-node',
  'ecosystem/identity-obj-proxy',
  'ecosystem/expect-type',
])

describeRecorded('ecosystem matchers, mocks and network, against Jest 30.5.2', PHASE_2B, FIXTURES)
