# @provino/bench

The benchmark protocol (Track 12 R5/R6), the synthetic suites, and the `provino-bench` CLI. The commands are in the root `CLAUDE.md`; the rules are in `.claude/rules/benchmarks.md`.

## Where things are

- `src/run-bench.ts`: the protocol. One discarded warm-up per subject, then 10 warm and 5 cold rounds, interleaved. A cold run deletes that subject's caches right before it starts.
- `src/kill-check.ts`: the R6 gate, pure. `evaluateKillCheck` takes a record and the parity reads and returns a verdict. It runs nothing.
- `src/commands.ts`: the CLI commands, including `killCheckCommand`, which does the running.
- `src/list-tests.ts`: `provino-bench list-tests <project dir>` (U2, B14c): Jest's `--listTests --json` (the project's own Jest when it has one) and `provino jest --listTests --json` (the bin, from source) in the directory, compared as sets (`compareLists`); prints both counts and every difference, exit 0 when the same set. It is how the 5 R6 repos are checked once B16 has put them on disk (`readLists` is a seam for the tests).
- `src/check.ts`, `src/parity.ts`: one run of a runner with a report, and Jest's statuses against Provino's.
- `src/generators/`: the suites. `.suites/` and `.results/` are gitignored.
- `src/loader/`, `src/worker/`, `src/expect/`, `src/mock/`: the `bench:*` benches, which run Provino's pieces in-process.
- `src/mock/`: `pnpm bench:mock [--max-create-us n] [--max-call-ratio n]`, T4.3's bars. `@provino/mock` under the Jest and Vitest mock policies against `@vitest/spy` and `jest-mock`, one process per engine, 5 interleaved runs, medians (8 rounds per process, first 2 discarded). `report.ts` is the pure part (flags, medians, ratio, the bars) and has the tests; `entry.ts` is one engine's side; `cli.ts` runs and prints. Creation cells exclude first-use cost, which `createMockFn` defers on purpose (state arrays and the dirty set, on the first call or `.mock` read), while the baselines pay it at creation. The `fn(arrow)+use` column (create, call once, read `.mock.calls.length`) shows it for every engine; it has no bar and is not in `failures()`, because the bar is on creation alone (automock's untouched mocks). Failure text adds decimals until a failed value differs from its bar. `cli.ts` calls `exitOnSignals()`, since each child runs in its own group. Every number is `local`. **It exits 1 today, by D31:** `fn(function)` under the Vitest policy (`chain-to-impl`) misses 1 µs (about 1.3 to 1.4 µs). No cell is exempt in code; it is named in the output, and T4.3 stays partial until the real `vitestPolicy` is re-measured. Exit 2 is bad usage.
- `src/env/`: `pnpm bench:env [--max-ratio n] [--max-heap-mb n] [--files n] [--rounds n]`, T8.3's jsdom bar (B17c part 3). One process: `@provino/env-jsdom` (`setup`, a workload, `teardown`) against a raw `JSDOM` loop doing the same (new window, `populateGlobal`, the workload, `populated.restore()`, `close()`), file by file with the first position alternating, `rounds` rounds of `files` files after one discarded round, median ratio with a bootstrap CI. The baseline is deliberately stricter than the environment: bare jsdom, `populateGlobal` and its own restore (without one the next file would populate over the last). It omits the environment's Node-global fills, the error bridge, the console forwarding and the descriptor snapshot and exact restore, so the ratio is what those cost over it, not over an equivalent. Heap: a warm-up of 10 files, GC, `files` files of the environment, GC, the growth (measured first in the process, before the baseline has run). Only the `fresh-global` row of the spike applies (`vm-window` needs the realm tier, T2.8). `report.ts` is the pure part with the tests. Every number is `local`; exit 1 on a miss, 2 on bad usage or a missing `--expose-gc`.
- `src/jest-config/`: `pnpm bench:jest-config load|presets|sample` (B14b), the Jest config reader against real jest-config 30.5.2. It lives here because `packages/dialect-jest/bench/` may import only types and policy. `compare.ts` is what both oracle checks compare: the 55 keys (46 project, 8 global, `preset` through its effects) and gap 5's one rule (a path into `babel-jest`, `jest-environment-node`, `jest-circus` or `jest-runner` compares package-relative); every other key (minus `seed`) is reported beside the bar. `load` times the Spike B fixture (`fixture.ts`, written as data) in fresh processes (`load-probe.ts`) and applies `--max-cold-ms` to the in-process and wall medians. `presets` writes small projects into `dialect-jest/oracle/presets/.work/` and reads them in-process. `sample` is D28's: `sample-select.ts` (F4's rules, pure), `sample-manifest.ts` (GitHub through `gh api`, answers cached in `.refs/jest-config-sample/api-cache/`), `sample-fetch.ts` (tarballs with `curl | tar`, the shared hoisted node_modules), `sample-run.ts` (each read in a child: `sample-probe.ts` with `network-guard.ts` preloaded, `--permission` with writes only to the results dir, proxy variables removed, a timeout). Every number is `local`.

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

**The verdict** is `NO-GO` if any measured check fails, otherwise `GO`. It is `PROVISIONAL` unless the record is `pinned`, every suite of `R6_SUITES` was measured, and it isn't a dry run. Completeness is judged against `R6_SUITES`, never against the list the caller passes, so a pinned record of a subset stays provisional, and a run that measured no suite is `NO-GO`. Exit 0 only means no measured check failed: on a provisional verdict that isn't a GO decision. Exit 1 means `NO-GO`, or that no verdict was reached (a refusal or a failure, which prints an error and no `VERDICT` line). Exit 1 from a dry run says nothing about the plumbing either way. `redesign` needs a real speed miss (a ratio whose upper bound is over its limit) on two suites; a missing result, a failing run or a dry run never counts.

**The record is exactly a `BenchRecord`.** It holds no verdict and no parity. The speed and isolation results can be re-derived from it; parity is only printed.

**The record is saved before anything is printed** (`persistRecord`, for `run` and `kill-check`): build, write, print the summary and verdict, then `wrote <path>` last. A throw while formatting or judging can't lose measured runs. If the write fails, the JSON goes to stderr at once, the summary and verdict still print, and the write error is rethrown. `cli.ts` guards stdout and stderr against a closed reader (`| head`), which would otherwise be an uncaught EPIPE.

**Two suites are measured** (B13c): app-500 (Provino at `registry` and `none`) and mock-heavy-500 (at `registry` only: R6's isolation condition is read on app-500). **A suite that throws** (writing it, `BENCH_CACHE_CLEAR_FAILED` inside its `runBench`) is caught per suite and printed (`<suite> FAILED before its runs were recorded`): it keeps no result, so every check of it fails for lack of data, and the other suites keep theirs in the record. Its runs before the throw are lost with it. A SIGINT mid-run still loses everything, which fits the no-partial-records protocol.

**Failure text never rounds across a limit.** A failed value is printed with enough decimals to differ from the printed limit (3599/4000 is `89.98%`, not `90.0%`); passing values keep their usual format.

**Which result is which:** `evaluateKillCheck` finds results by suite, cache state and role. Jest is `subject.runner === 'jest'`; the candidate is `subject.isolation === 'registry'`; the no-isolation subject is `subject.isolation === 'none'`.

**A dry run** gives Jest's own plan a `jest-as-provino` runner id, never `provino:jest`, so its record can't be taken for Provino's. It reads no parity and needs `--label local`.

## What the numbers mean today

- **Result reuse is off (D19) without `--no-cache`.** Provino's results cache only orders the next run's files and never skips one. Every timed run is a fresh process. `--no-cache` is only on the one-off parity read, which goes through `check`.
- **Provino runs from source** (`--conditions=provino-source`), so every process pays type stripping. There is no built `dist` to measure yet.
- **mock-heavy-500 pays the hoister on every cold run:** its Jest tree is CommonJS, so each test file moves its three `jest.mock` calls and rewrites no imports, and every source file passes the hoister's prefilter. Every edge asks the file's module-mock registry. Map composition is not deferred (B13b's suggestion): the cold ratio met its bar without it (B13c, `local`). A warm run reads the hoisted output from the transform cache instead (B17d).
- **`provino run` has a transform cache (T3.6, B17d), and cold runs delete it.** It is `<tree>/node_modules/.cache/provino/t`, inside the directory the Provino plan already lists in `caches` (`jest/node_modules/.cache/provino`, kind `provino`), so a cold run starts with no transform cache, and `suites.test.ts` pins that the directory is inside a listed one. If the cache ever moves out of it, add it to `caches` or cold runs stop being cold. A warm run is helped by three things now: the transform cache, the V8 compile cache and the results history. `pnpm bench:transform-cache` (in `packages/transform/bench/`) is T3.6's own bar, not part of the protocol.
- **Peak RSS needs `ps`.** A run inside a sandbox that blocks `ps` records no `peakRssMb` and says so in a note.
- **Both Provino tiers share a tree and caches.** That is safe, because a cold run clears them right before its own run and the results cache only orders files.
- **`provino.config.mjs` states `isolation: 'registry'`** and `provino.none.config.mjs` states `none`. The explicit tier stops the gate silently measuring something else if the Jest default ever moves (build-plan §4 item 34).
