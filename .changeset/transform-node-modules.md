---
"provino": patch
"@provino/dialect-jest": patch
"@provino/types": minor
---

`provino jest` transforms a package under `node_modules` that `transformIgnorePatterns` let through, as Jest does, when the package is ES module source: `next/jest`'s `transpilePackages`, or patterns that ignore no package, now work with an ES module package whose imports name a file without its extension. The package is transformed (by the project's transformer, or by Provino's own in place of the default `babel-jest`) and loaded per test file. A CommonJS package the patterns let through is still loaded by Node, once per worker. Under Jest's default patterns an ES module package that Node can't load fails with Jest's `Must use import to load ES Module` text in place of Node's `ERR_MODULE_NOT_FOUND`.

`@provino/types`: `TransformClaims`, `LoaderOptions.transformClaims`, `SerializedLoaderConfig.transformClaims` and `NeutralProject.standInTransformPatterns`.
