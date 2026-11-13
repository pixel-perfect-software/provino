// `provino/globals`: ambient declarations for the globals the Jest dialect injects into a test
// file (`describe`, `it`, `test`, the hooks and `expect`), typed as the `provino` entry types them.
// Import it for its types only, for a project that wants the globals typed without `@types/jest`:
// `import 'provino/globals'`, or list it in `compilerOptions.types`. The import has no effect at
// run time.
import type { WorkerApi } from './index.ts'

declare global {
  // `var`, not `const`: only a `var` declares a property of `globalThis`.
  var describe: WorkerApi['describe']
  var it: WorkerApi['it']
  var test: WorkerApi['test']
  var beforeAll: WorkerApi['beforeAll']
  var afterAll: WorkerApi['afterAll']
  var beforeEach: WorkerApi['beforeEach']
  var afterEach: WorkerApi['afterEach']
  var expect: WorkerApi['expect']
}
