// `provino/globals`: ambient declarations for the globals a test file can find: the ones the Jest
// dialect injects (`describe`, `it`, `test`, the four hooks and `expect`) and the rest of the
// native API, which a project with no dialect installs under `globals: true` (D185), typed as the
// `provino` entry types them. Import it for its types only, for a project that wants the globals
// typed without `@types/jest`: `import 'provino/globals'`, or list it in `compilerOptions.types`.
// The import has no effect at run time.
import type { ProvinoApi } from './index.ts'

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
  var mocks: ProvinoApi['mocks']
  var timers: ProvinoApi['timers']
}
