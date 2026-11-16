---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`provino jest` resolves the imports of a test file Jest runs as CommonJS with Jest's CommonJS conditions, as jest-runtime does: an `import` that the project's transform would turn into `require` takes a dual package's `require` entry, not its `import` one, in the test file and in every module it loads. A file Jest runs as an ES module (`.mjs`, a `"type": "module"` package's `.js`, or an extension in `extensionsToTreatAsEsm`, with Node's `--experimental-vm-modules`) keeps the `import` entry. `@testing-library/jest-dom/jest-globals` now loads its CommonJS build beside `@jest/globals`. A package with only an `import` entry is not found from a file Jest runs as CommonJS, as in Jest, so a virtual `jest.mock` of it serves the import. Other dialects resolve each edge as it is written.

`provino`'s `exports` give every subpath a `default` condition naming its `import` file, so `require('provino')` (and a test file Jest runs as CommonJS that imports it) loads the ES module through Node's `require(esm)`.

A dual package's `module-sync` entry is taken as Jest takes it: by every edge of a file Jest runs as an ES module, and by a file Jest runs as CommonJS only when Node evaluates ES modules synchronously (24.9 and later, under `--experimental-vm-modules`); a `jest.mock` of such a package resolves to the same file.

`@provino/types`: `ModulePolicy.edgeResolveKind`, `ModulePolicy.moduleSyncCondition`, `LoaderOptions.esmExtensions`, `SerializedLoaderConfig.esmExtensions` and `NeutralResolution.esmExtensions`.
