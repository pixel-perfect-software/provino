# Vendored upstream: the hoist test inputs

Two JSON files hold the inputs of the upstream tests for mock hoisting. `hoist-corpus.test.ts` reads
only these files and runs each input through the real, pinned hoister and through Provino's
`hoistMocks`. They are written by `pnpm hoist:extract`, which parses the upstream test files with
`oxc-parser` (local only: `.refs/` is not on CI). The files hold no upstream code beyond those
inputs, and JSON can't carry a license header, so each file has a `license` field.

## `jest.json`

- **Repository:** https://github.com/jestjs/jest (MIT, © Meta Platforms, Inc. and affiliates)
- **Tag:** `v30.5.2`, commit `202dd8a14777c270607c2416bd5034c3c0abc984` (DECISIONS S3)
- **Source path:** `packages/babel-plugin-jest-hoist/src/__tests__/hoistPlugin.nodejs18.test.ts` (the Babel 8 file re-runs the same cases)
- **Copied:** 2026-11-06, from the clone in `.refs/jest`
- **Cases:** 12, the keys of `pluginTester({ tests })`. Each has the `code` (Prettier's formatting left out: it changes whitespace only), the file name Babel was given and, for `automatic react runtime`, `jsx: "automatic"`. The reference runs `babel-plugin-jest-hoist` 30.5.0, the version `jest@30.5.2` depends on.

## `vitest.json`

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © 2021-Present VoidZero Inc. and Vitest contributors)
- **Tag:** `v5.0.5`, commit `7a825db43e2beca0b219d2eadaec334cb81af0c7` (`git ls-remote https://github.com/vitest-dev/vitest refs/tags/v5.0.5`, 2026-11-06)
- **Source path:** `test/unit/test/injector-mock.test.ts`
- **Copied:** 2026-11-06, from the clone in `.refs/vitest`
- **Cases:** 96: every `test`/`it` that calls `hoistSimple`, `hoistSimpleCode`, `hoistSimpleCodeWithoutMocks` or `hoistMockAndResolve` with a literal input (one case per call, so a test with two calls gives `name` and `name #2`), plus the 15 rows of the `it.each` table. `hoistSimpleCodeWithoutMocks` is expanded as upstream defines it: `import {vi} from "vitest";\n<input>\nvi.mock('faker');\n`. The reference is `hoistMocks` from `@vitest/mocker` 5.0.5 (`hoistMockAndResolve`), parsed with `oxc-parser` instead of Vite's `parseAst`.

## Not copied

The expected outputs (snapshots), the options a test passes (`getMap`, `onStaticMock`) and the source-map and static-mock assertions. The check compares the real hoister's output with ours, live, so no snapshot can drift.

## Local patches

None. The inputs are unchanged apart from the wrapper above.
