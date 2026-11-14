---
"@provino/types": minor
"@provino/dialect-jest": minor
"provino": minor
---

`coverageProvider: 'v8'` now counts a CommonJS module as Jest does: the vm script and the wrapper the loader compiles the module in count nowhere but as the module's own function, at any worker count. A file that ends in types has a statement on each of their lines, as Jest's documented `babel-jest` with `@babel/preset-typescript` reports it. The new policy key `coverage.v8Hashbang` (Jest: `removed`) reproduces Jest's offsets for a module that starts with a hashbang. A module's code and map cross from the workers once per run: `WorkerInit.coverageModules` names what the coordinator already holds, and a worker sends those as an `ExecutedModuleRef`.
