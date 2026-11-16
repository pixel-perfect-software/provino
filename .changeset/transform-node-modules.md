---
"provino": patch
"@provino/dialect-jest": patch
"@provino/types": minor
---

`provino jest` transforms a package under `node_modules` that `transformIgnorePatterns` let through, as Jest does, when Node can't load it natively: ES module syntax, a TypeScript or JSX extension, or a CommonJS file Node fails to parse (JSX or Flow in a React Native package). `next/jest`'s `transpilePackages`, patterns that ignore no package, and React Native's preset now work. Such a file is transformed (by the project's transformer, or by Provino's own in place of the default `babel-jest`) and loaded per test file, and a CommonJS package that requires one is loaded per test file too, so both see one copy. Any other CommonJS package the patterns let through is still loaded by Node, once per worker. Under Jest's default patterns an ES module package that Node can't load fails with Jest's `Must use import to load ES Module` text in place of Node's `ERR_MODULE_NOT_FOUND`, under Jest's conditions (not for a `.cjs` file or a `"type": "commonjs"` package, and not where Node evaluates ES modules synchronously). `transformIgnorePatterns` that are not regular expressions, alone or joined with `|`, are a config error even with no transform.

`@provino/types`: `TransformClaims`, `LoaderOptions.transformClaims`, `SerializedLoaderConfig.transformClaims` and `NeutralProject.standInTransformPatterns`.
