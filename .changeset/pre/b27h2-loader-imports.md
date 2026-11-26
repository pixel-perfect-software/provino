---
"@provino/loader": patch
---

An `import()` with a query string (`./x.ts?v`) reads the file without it, each URL its own module; `import()` of a `data:` URL, or of a scheme a `module.registerHooks` hook serves, loads as Node loads it.
