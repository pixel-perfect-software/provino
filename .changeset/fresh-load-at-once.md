---
"provino": patch
"@provino/config": patch
"@provino/dialect-jest": patch
---

`provino jest --projects a b` (or a config's `projects`) no longer fails with Node's `ERR_INTERNAL_ASSERTION` when the projects share a CommonJS custom `resolver` or preset, such as `ts-jest-resolver`. Each project's config is read at once, as Jest reads them, and each loaded the shared file afresh: a second fresh load of a CommonJS file deleted its entry in Node's module cache while Node was still loading the first, and Node's own check failed. `importConfigModule` now runs the fresh loads of one file one after another, so every one still reads the file anew. A resolver that can't load is reported with the underlying error's stack, as jest-cli prints it, not only its message.
