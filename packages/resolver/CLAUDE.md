# @provino/resolver

The module resolver (Track 3, T3.2): `createResolver` over `oxc-resolver`, the Jest `moduleNameMapper` as `createNameMapper` and `jestModuleNameMapper`, and `ResolverError`. The contract (`Resolver`, `ResolveResult`, `ResolverOptions`) is in `@provino/types`. This file covers the corpus bench, the one part with non-obvious structure.

## The corpus bench (`pnpm bench:resolve`)

`bench/resolve-corpus.ts` asks Node's own ESM resolution and Provino's resolver the same requests and compares the answers. The bar is at least 531 compared requests and an agreement of at least 529/531; `--max-warm-us 15` adds the warm timing bar. Its pieces are in `bench/requests.ts` (tests: `bench/requests.test.ts`, run by `pnpm test --filter @provino/resolver`).

- **Requests:** every installed third-party package's bare name, plus each of its literal `exports` subpaths, from pnpm's hoisted store (`node_modules/.pnpm/node_modules`).
- **The workspace's own packages are left out, and the output says how many** (`left out: 24 workspace packages`; `excludedWorkspacePackages` in `--json`). pnpm links them into that store, but they aren't third-party resolution cases: their `exports` name `provino-source` first and a `dist/` file last, so what Node answers depends on whether a build ran. CI runs this with no `dist/`, where the resolver answered `null` for each (38 disagreements, 1744/1782); the corpus is the same, 1744 compared, with or without a build.
- **A target whose file is missing is no answer.** Node's `import.meta.resolve` returns the URL an `exports` target names without looking for the file (a real `import()` of it throws `ERR_MODULE_NOT_FOUND`); `oxc-resolver` checks, and answers "not found". They agree that nothing loads, so `withoutMissingTargets` reads such an answer as the error `import` would throw, and the request counts as excluded ("excluded (Node errors, or a target whose file is missing)"), not as a disagreement. This is the real difference between the two resolvers on a missing target, and Provino's side is the one that matches what an import does.
- Every number is `local`; the Node baseline runs in a child process because `import.meta.resolve`'s parent argument needs `--experimental-import-meta-resolve`.
