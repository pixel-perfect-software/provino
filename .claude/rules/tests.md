---
paths:
  - "**/*.test.ts"
  - "**/*.test-d.ts"
  - "packages/harness/**"
  - "**/fixtures/**"
  - "**/__goldens__/**"
---

# Test, type-test and fixture rules

- **Unit tests use `node:test` + `node:assert/strict`** (DECISIONS S1), next to the source as `*.test.ts`. Use the test command in `CLAUDE.md`; it carries the strip-types and source-condition flags. Jest and Vitest are never our own runner; they appear only as *subjects* in the harness and bench.
- **Type tests** (`*.test-d.ts`) use `expect-type` and must pass on TypeScript 7.0.2 and 5.9.3. Every misuse case is a `@ts-expect-error` line. Where the research gives the expected error text, assert a substring of the message so the error can't be a different one.
- **Goldens are recorded, never hand-edited.** Ground-truth observations and message/snapshot goldens come from running real Jest 30.5 / Vitest 5.0 through the recorder (one fixture format, T12.1). To change a golden, re-record it and explain why in the commit.
- **Determinism is a requirement.** Recorders must produce byte-identical output twice in a row. Seed anything random, and normalise paths, timings and PIDs through the harness's normalisation rules.
- **Never make a failing check pass by editing the expectation.** If Provino and the golden disagree, either Provino is wrong or the divergence is deliberate. Deliberate divergences follow DECISIONS D7, and each is listed in `docs/plan/DIVERGENCES.md` with the fixture that shows it.
- **Keep fixtures small and named for the behaviour** (`hook-order-after-each-reverse`), not numbered.
- **Real-time waits are banned in unit tests.** Use fake clocks or explicit signals; flaky tests get fixed or deleted, never retried into green.
