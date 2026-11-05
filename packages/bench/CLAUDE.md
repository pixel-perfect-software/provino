# @provino/bench

The benchmark protocol (Track 12 R5/R6), the synthetic suites, and the `provino-bench` CLI. The commands are in the root `CLAUDE.md`; the rules are in `.claude/rules/benchmarks.md`.

## Where things are

- `src/run-bench.ts`: the protocol. One discarded warm-up per subject, then 10 warm and 5 cold rounds, interleaved. A cold run deletes that subject's caches right before it starts.
- `src/kill-check.ts`: the R6 gate, pure. `evaluateKillCheck` takes a record and the parity reads and returns a verdict. It runs nothing.
- `src/commands.ts`: the CLI commands, including `killCheckCommand`, which does the running.
- `src/check.ts`, `src/parity.ts`: one run of a runner with a report, and Jest's statuses against Provino's.
- `src/generators/`: the suites. `.suites/` and `.results/` are gitignored.
- `src/loader/`, `src/worker/`, `src/expect/`: the `bench:*` benches, which run Provino's pieces in-process.

## The kill-check

**The gate is final; its inputs grow.** A suite joins by losing its `pending` reason in `R6_SUITES`. `KILL_CRITERION` is D5 and is never edited to pass.

**How each check is read:**

| Check | Compared against the limit | Limit |
| --- | --- | --- |
| Speed, warm | upper bound of the 95% CI of Provino registry / Jest | ≤ 0.50 |
| Speed, cold | the same | ≤ 0.80 |
| Isolation, on app-500, warm and cold | the ratio of the medians, registry / none (its CI is only printed) | ≤ 3.0 |
| Status parity (R2) | Jest's tests whose status Provino matches | ≥ 90% |

A missing result, a failing run or an unreadable parity read fails its check. Nothing is treated as passing for lack of data.

**R6 asks for parity only on the 5 repos.** We read it on every measured suite and hold the same bar, because a faster runner that is wrong doesn't count.

**The verdict** is `NO-GO` if any measured check fails, otherwise `GO`. It is `PROVISIONAL` unless the record is `pinned`, no suite is pending, and it isn't a dry run. Exit 0 only means no measured check failed: on a provisional verdict that isn't a GO decision.

**The record is exactly a `BenchRecord`.** It holds no verdict and no parity. The speed and isolation results can be re-derived from it; parity is only printed.

**Which result is which:** `evaluateKillCheck` finds results by suite, cache state and role. Jest is `subject.runner === 'jest'`; the candidate is `subject.isolation === 'registry'`; the no-isolation subject is `subject.isolation === 'none'`.

**A dry run** gives Jest's own plan a `jest-as-provino` runner id, never `provino:jest`, so its record can't be taken for Provino's. It reads no parity and needs `--label local`.

## What the numbers mean today

- **Result reuse is off (D19) without `--no-cache`.** Provino's results cache only orders the next run's files and never skips one. Every timed run is a fresh process. `--no-cache` is only on the one-off parity read, which goes through `check`.
- **Provino runs from source** (`--conditions=provino-source`), so every process pays type stripping. There is no built `dist` to measure yet.
- **`provino run` has no transform cache yet** (T3.6, B17), so warm gains little over cold. When it lands, its directory must be in the plan's `caches`, or cold runs stop being cold.
- **Both Provino tiers share a tree and caches.** That is safe, because a cold run clears them right before its own run and the results cache only orders files.
- **`provino.config.mjs` states `isolation: 'registry'`** and `provino.none.config.mjs` states `none`. The explicit tier stops the gate silently measuring something else if the Jest default ever moves (build-plan §4 item 34).
