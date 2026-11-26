---
"provino": patch
---

`import { describe, it, expect, lazy } from 'provino'` now typechecks in a user's project. The root entry's `types` file (`dist/index.d.ts`) was a declaration chunk the other entries share, whose names are mangled (`$`, `_`, `A`…), so TypeScript found none of the native API (TS2305, and TS2693 for `it`); the entry's own declarations were in `dist/index5.d.ts`. The shared declaration chunks are now in `dist/chunks/`, so every entry's `types` file is its own, and the build fails when an entry is not written to the file its `exports` name. The JavaScript is unchanged.
