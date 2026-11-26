---
'provino': patch
'@provino/dialect-jest': patch
'@provino/dialect-vitest': patch
---

`defineConfig({ dialect: 'jest' })` and `'vitest'` now type-check against the published packages. The dialects register their name on `DialectRegistry` by declaration merging, and the built declarations named `@provino/types`, which no install has, so `DialectName` was `never`. They now name `provino/config`, which exports `DialectRegistry`, `PluginRegistry` and `ProvidedContext` (augment those there). `provino`'s internal declarations no longer hold a second copy of the three.
