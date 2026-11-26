// `provino/globals/native`: ambient declarations for the globals a project with no dialect installs
// under `globals: true` (D185): every name of the native API (`ProvinoApi`). Types only, like
// `provino/globals`, whose Jest-typed globals it can't be used beside (the two type `test` and
// `it` differently: the native ones have `extend`).
// A `tsc -b` project of its own (`tsconfig.json` here), so it names the API by package.
import type { ProvinoApi } from '@provino/api'

declare global {
  // `var`, not `const`: only a `var` declares a property of `globalThis`.
  var describe: ProvinoApi['describe']
  var suite: ProvinoApi['suite']
  var it: ProvinoApi['it']
  var test: ProvinoApi['test']
  var beforeAll: ProvinoApi['beforeAll']
  var afterAll: ProvinoApi['afterAll']
  var beforeEach: ProvinoApi['beforeEach']
  var afterEach: ProvinoApi['afterEach']
  var aroundEach: ProvinoApi['aroundEach']
  var aroundAll: ProvinoApi['aroundAll']
  var onTestFinished: ProvinoApi['onTestFinished']
  var onTestFailed: ProvinoApi['onTestFailed']
  var expect: ProvinoApi['expect']
  var fn: ProvinoApi['fn']
  var spyOn: ProvinoApi['spyOn']
  var replaceProperty: ProvinoApi['replaceProperty']
  var isMockFunction: ProvinoApi['isMockFunction']
  var mocked: ProvinoApi['mocked']
  var mocks: ProvinoApi['mocks']
  var timers: ProvinoApi['timers']
}
