---
paths:
  - "**/*.test.ts"
  - "**/*.test-d.ts"
  - "packages/harness/**"
  - "**/fixtures/**"
  - "**/__goldens__/**"
---

# Test, type-test and fixture rules

- **Unit tests use `node:test` + `node:assert/strict`** (DECISIONS S1), next to the source as `*.test.ts`. Use the test command in `CLAUDE.md`; it carries the source-condition flag. On Node below 22.18, set `NODE_OPTIONS=--experimental-strip-types` (S1; CI's 22.15 leg does). Jest and Vitest are never our own runner; they appear only as *subjects* in the harness and bench.
- **Type tests** (`*.test-d.ts`) use `expect-type` and must pass on TypeScript 7.0.2 and 5.9.3. Every misuse case is a `@ts-expect-error` line. Where the research gives the expected error text, assert a substring of the message so the error can't be a different one.
- **Goldens are recorded, never hand-edited.** Ground-truth observations and message/snapshot goldens come from running real Jest 30.5 / Vitest 5.0 through the recorder (one fixture format, T12.1). To change a golden, re-record it and explain why in the commit. Two recorded oracles are not recorder fixtures, real Vitest's `parseCLI` answers (`record:cli`) and real Babel's output for the Jest hoist layouts (`record:hoist`): CI re-checks each against the real tool with its `--check`, in place of the T12.1 recorder.
- **Determinism is a requirement.** Recorders must produce byte-identical output twice in a row. Seed anything random, and normalise paths, timings and PIDs through the harness's normalisation rules.
- **Never make a failing check pass by editing the expectation.** If Provino and the golden disagree, either Provino is wrong or the divergence is deliberate. Deliberate divergences follow DECISIONS D7, and each is listed in `docs/plan/DIVERGENCES.md` with the fixture that shows it.
- **Keep fixtures small and named for the behaviour** (`hook-order-after-each-reverse`), not numbered.
- **A test file does no work when it is imported.** The dogfood completeness test imports every file with `-t` to list it (`tooling/packaging/src/dogfood.test.ts`), and a `describe` body runs then too, so an oracle, a child process, a corpus load or a temp-dir build at module scope or in a `describe` body runs on every listing, and a skipped file never cleans up after it. Start it from the first test that needs it, memoised when several share it (`oracleOutcomes()` in `packages/dialect-jest/src/node/cli.test.ts`), or from a `beforeAll`, which a listing never runs. The same test makes each listing's `TMPDIR` an empty directory and fails when a listing leaves anything in it.
- **Reading the repo's own file list to name tests** (`migratedDirs`, `bootstrapFiles`, a directory listing in a `describe` body) is allowed import-time work: it is cheap, makes nothing on disk, and the test names come from it.
- **A test helper does not import `node:test` when a Provino-run test imports it.** A node:test `after`, `test` or `describe` does nothing in a Provino worker (a temp dir its `after` was to remove stays). A helper that only Provino tests import uses `afterAll`/`onTestFinished` from `provino`; one that bootstrap (node:test) files import too takes the hook as a parameter or the test's `t`. The mirror holds too: a file a bootstrap test reaches makes no value import of `provino` (its `afterAll` registers nothing under node:test). `test-shards.ts check` fails on either.
- **A test writes scratch files to the OS temp dir (or a `.work/` dir), never into a checked-in folder, a fixture's included.** Tests of other packages run at the same time as the boundaries scan, which lists every checked-in folder (B27h3).
- **Real-time waits are banned in unit tests.** Use fake clocks or explicit signals; flaky tests get fixed or deleted, never retried into green.
