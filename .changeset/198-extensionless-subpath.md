---
"provino": patch
"@provino/loader": patch
"@provino/orchestrator": patch
---

A dependency that Node loads itself (an ES module in `node_modules`) can import a subpath of a package with no `exports` map without its extension, as `import { NextResponse } from 'next/server'` does: the worker resolves it as `require` would. Before, the test file failed to load with "Cannot find module … Did you mean to import …?".
