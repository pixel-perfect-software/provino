---
"provino": patch
"@provino/loader": patch
"@provino/core": patch
---

A CommonJS test or module can call `import()`: it loads through the file's own module registry, where it used to throw `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `import.meta` has no prototype, as Node's, and `import.meta.resolve` answers a relative, absolute or `file:` specifier it can't find with the URL it names, as Node does (a missing package still throws). The loader's semantics are now checked against native Node, case by case (live bindings, cycles, top-level await, `import.meta`, `import()`, `require(esm)`, `__esModule` under both interops, JSON, a shared `.node` addon, `require.cache`, re-evaluation after a failure); the differences that remain are listed as divergences. The test runtime costs less per test (about 7 µs to 5 µs for an empty test with three hooks): the test context's keys are plain properties, as Vitest's are, so they are now writable.
