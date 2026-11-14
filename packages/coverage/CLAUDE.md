# @provino/coverage

Code coverage (layer 2, neutral: no dialect name, D111; `runsIn: both`, slice `coverage`). Three entries: `.` (the error and the filter), `./runtime` (the worker's half) and `./node` (the coordinator's half). Jest's texts and values are policy data (`dialect-jest/src/dialect.ts`), its config translation is `dialect-jest/src/node/coverage.ts`. B23b built it for `provino jest`; `provino run`'s own coverage waits for T1.4/B25.

## Two providers

- **Istanbul** (`coverageProvider: 'babel'` under Jest): the worker's transform pipeline instruments each user file after TypeScript is stripped and before the hoister (`createPipeline({ instrumenter })`, U6). The instrumenter is `@vitest/istanbul-lib-instrument` 2.1.0 vendored on `oxc-parser` (`src/vendor/istanbul-lib-instrument/`, `UPSTREAM.md`, its own tsconfig, D17). A project whose transform is the real `babel-jest` gets `instrument: true` passed through instead (`canInstrument`), as Jest does. Counters live in the worker global `policy.istanbulVariable` (`__coverage__`).
- **V8** (`'v8'`): `runtime/v8-collector.ts` starts `Profiler.startPreciseCoverage({ callCount, detailed: true })` at the very top of worker boot and takes it once per worker at `stop` (DV94), keeping the compiled `file:` URLs the filter passes. The coordinator converts with `v8-to-istanbul` (`node/v8.ts`) under `policy.v8Conversion: 'v8-to-istanbul'`; `'ast'` (neutral) throws `COVERAGE_NOT_IMPLEMENTED` naming B25. The wrapper's length goes to `v8-to-istanbul` as `wrapperLength` (Jest passes 0 because it compiles with `compileFunction`).

## Module map

| Path | Role |
|---|---|
| `src/errors.ts` | `CoverageError`, codes `COVERAGE_NOT_IMPLEMENTED`, `_BAD_CONFIG`, `_INSTRUMENT_FAILED`, `_BAD_DATA`, `_REPORT_FAILED` |
| `src/filter.ts` | `createCoverageFilter(SerializedCoverageConfig)`: Jest's `shouldInstrument` order as data (picomatch `globsToMatcher`); used by both halves |
| `src/instrument.ts`, `initial-coverage.ts`, `load-instrumenter.ts` | `istanbulInstrumenter({ coverageVariable })` (embeds the input map like babel-plugin-istanbul), `readInitialCoverage(code)` on oxc-parser, and `loadInstrumenter()`, the lazy import both halves use |
| `src/code-identity.ts` | a hash of this package's own code for the transform cache key (the version is `0.0.0`) |
| `src/runtime/` | worker: `istanbul-collector.ts` (deep-copies `__coverage__` before each file's environment teardown and zeroes the counters in place), `v8-collector.ts`, `intern.ts` (a file's maps cross once per worker; later takes carry counters only) |
| `src/node/expand.ts` | puts the interned maps back (`expandIstanbulData`, `KnownMaps`) |
| `src/node/aggregate.ts`, `remap.ts`, `totals.ts` | merge (`istanbul-lib-coverage`), move back to the sources (`istanbul-lib-source-maps`, with `sources` for text not on disk), per-metric totals |
| `src/node/v8.ts` | `mergeProcessCovs`, `convertV8Coverage`, `emptyV8Coverage` (Jest's `(empty-report)` range over the file's size) |
| `src/node/reports.ts` | `writeCoverageReports(map, { reporters, dir, watermarks, maxCols, stdout, sourceFinder })`: `istanbul-reports` over one `istanbul-lib-report` context, console reports to the given stream |
| `src/node/thresholds.ts`, `threshold-paths.ts` | `checkThresholds`: Jest's `_checkThreshold` (first-match grouping, glob groups per file, path groups on totals, negatives cap uncovered counts, metric order statements/branches/lines/functions); the words come from `policy.thresholdMessages` |
| `src/node/reporting.ts` | what `loadCoverageReporting()` imports. The `./node` entry stays light: the Istanbul report libraries load only through it |

## The halves

- **Worker** (`@provino/orchestrator`'s worker): `config.coverage` on the `SerializedProjectConfig` makes `worker/runtime/runner.ts` dynamic-import `@provino/coverage/runtime` (`startCoverage`), start V8's profiler before the project's files load, hand the instrumenter and filter to the loader, and send `coverage` events. Nothing coverage-shaped crosses as a closure (NN4).
- **Coordinator:** `orchestrator/src/coverage-store.ts` collects the events per run; `coverage.ts` merges, adds the files no test loaded (instrumented for initial coverage, or Jest's empty V8 report; `Failed to collect coverage from <file>`), remaps, and finishes into `RunSummary.coverage` before `run:end`. `provino/src/internal/coverage-reporter.ts` writes the reports and then the threshold lines (stderr, red with colour), after custom reporters and before `summary`. Threshold failures are `exitCodes.failure` and `success: false`.
- Both import this package only behind a dynamic import with coverage on. `packages/provino/test/exports.test.ts` records a source run's coordinator, and `exports-coverage.test.ts` the built package's processes: no `coverage*`, `instrument`, `initial-coverage`, `reporting` or `runtime` chunk loads without coverage, and `dist/coverage.js` does with it. The `coverage` chunk is `COVERAGE` in `tooling/packaging/src/umbrella.ts`.

## Policy keys (`CoveragePolicy`)

`thresholdGrouping`, `globThresholdScope`, `includeUntestedByDefault`, `reportsDirectory`, `v8Conversion`, `v8HitCounts`, `v8Hashbang`, `istanbulVariable`, `thresholdMessages`. Jest's values are claimed in `packages/harness/src/policy-truth/claims/coverage.ts` and held by the goldens below; Vitest's are `pending('B25')`.

## Tests

- Unit (`pnpm test --filter @provino/coverage`): `instrument.test.ts` (maps against `babel-plugin-istanbul` 8.0.0 over a table), `initial-coverage.test.ts` (against `istanbul-lib-instrument` 6.0.3), `filter.test.ts` (against `@jest/transform`'s `shouldInstrument`), `thresholds.test.ts` (against `@jest/reporters` 30.5.2's `_checkThreshold`), `runtime/collectors.test.ts`, `node/merge.test.ts`, `node/reports.test.ts`, `node/expand.test.ts`.
- Elsewhere: `loader/src/coverage.test.ts` (T2.9: zero offset errors), `orchestrator/test/coverage-collect.test.ts`, `coverage-merge.test.ts` (3 workers by 2 shards equal one run), `coverage-run.test.ts`, and `provino/test/jest-coverage*.test.ts` against the goldens in `packages/harness/fixtures/coverage` (`pnpm provino-harness record --check packages/harness/fixtures/coverage`): `babel-providers-sample`, `v8-providers-sample`, `v8-untested`, the `threshold-*` set, `babel-defaults`, `babel-path-ignore`, `babel-cwd-below-root`, `istanbul-variable`.

## Divergences and not built

DV94 (V8 once per worker), DV98 (17 V8 range positions), DV99 (uninitialized class fields under V8), DV100 (`instrumentRoot` under babel-jest), DV101 (`_coverageSchema` is Jest's under every dialect), DV120 (files the in-place strip can't take fall back to Oxc and remap). Not built: `--merge-reports` (T9.8), HTML reports compared byte for byte, `provino run`'s coverage config (T1.4/B25), the AST V8 converter and Vitest's thresholds (B25), changed-file coverage (B23c).
