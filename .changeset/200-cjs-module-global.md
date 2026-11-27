---
"provino": patch
"@provino/loader": patch
---

A native ES module that names `module` (an entry point bundled to CommonJS that checks `require.main === module`) no longer throws `ReferenceError: module is not defined`: it gets a `module` object of its own, so the check is false when the file is imported.
