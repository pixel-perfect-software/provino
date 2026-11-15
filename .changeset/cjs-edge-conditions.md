---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": minor
---

`provino jest` resolves the imports of a test file Jest runs as CommonJS with Jest's CommonJS conditions, as jest-runtime does: an `import` that the project's transform would turn into `require` takes a dual package's `require` entry, not its `import` one, in the test file and in every module it loads. A file Jest runs as an ES module (`.mjs`, a `"type": "module"` package's `.js`, or an extension in `extensionsToTreatAsEsm`, with Node's `--experimental-vm-modules`) keeps the `import` entry. `@testing-library/jest-dom/jest-globals` now loads its CommonJS build beside `@jest/globals`. Other dialects resolve each edge as it is written.

`@provino/types`: `ModulePolicy.edgeResolveKind`, `LoaderOptions.esmExtensions`, `SerializedLoaderConfig.esmExtensions` and `NeutralResolution.esmExtensions`.
