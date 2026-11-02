# @provino/harness

Dev-only (private). Turns Jest and Vitest output into the neutral result model, diffs two runs, and records the **golden fixtures** every later bundle reuses for ground truth: policy values (T1.7), mocking probes (T4.1), runtime traces (T5.2) and matcher-message goldens (T7.1). Spec: Track 12 (F1/F2, R1/R2, Harness API, site contract). Result types are in `@provino/types` (`result.ts`, `bench.ts`); this package holds the runtime.

## What is here

| File                                       | Role                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `src/normalize.ts`                         | `rules` (the 9 F2 rules, each with an id), `normalizeText`, `normalizeError`, `testKey`                            |
| `src/convert-jest.ts`, `convert-vitest.ts` | `convertJest` (both `--json` and `AggregatedResult` shapes), `convertVitest`; `convert-options.ts` has the options |
| `src/parse-results.ts`                     | `parseJestJson` / `parseVitestJson`: envelope guards for JSON read from disk                                       |
| `src/diff.ts`                              | `diffRuns` → `ParityReport` (R1/R2), exclusions with expiry                                                        |
| `src/site.ts`                              | the `./site` entry: `ApiRow`, `ParitySummary`, `SiteIndex`, re-exported bench types                                |
| `src/fixture.ts`                           | `fixture.json` validation, test-file selection, fixture discovery                                                  |
| `src/record.ts`, `golden.ts`               | `recordFixture`, the golden type and its byte-stable serializer                                                    |
| `src/jest-transform.ts`                    | Jest transformer: `module.stripTypeScriptTypes`, then `babel-jest` (the `./jest-transform` export)                 |
| `src/cli.ts`                               | `provino-harness record [--check] [--keep] [<fixture dir>...]`                                                     |

## Fixture format

A fixture is a directory `fixtures/<area>/<behaviour>/` (named for the behaviour, not numbered):

- `fixture.json`: `{ "description": string, "runners": ("jest" | "vitest")[], "env"?: Record<string, string> }`. Anything else is a coded error (`HARNESS_FIXTURE_*`).
- TypeScript test files: `*.test.ts` run under **every** listed runner; `*.jest.test.ts` only under Jest; `*.vitest.test.ts` only under Vitest (for `jest.mock` vs `vi.mock`). Support files (helpers) are copied but never run. Every listed runner needs at least one test file.
- Tests use the runner globals (`describe`, `it`, `expect`, `jest`, `vi`). Type annotations are fine; the syntax must be erasable (no `enum`).
- Fixtures carry **no runner config**: the recorder writes it (see `internal/runner-config.ts`).
- `__goldens__/<runner>.json`: written by the recorder, never by hand.

## Recorder contract

`recordFixture(dir, runner, { check? })` copies the fixture to a fresh directory under `.record/` (inside the package, so `node_modules` resolution finds the runners), writes the runner config, and runs the pinned Jest 30.5.2 / Vitest 5.0.5 with `CI=1`, `TZ=UTC`, `NO_COLOR=1` (and your `env`). It converts the JSON, normalizes with that directory as `<root>`, and writes the golden: a `NormalizedRun` without `startedAt`, `env`, every duration and every `raw` (the runner's text holds machine paths). Keys are in a fixed order; 2-space JSON and a trailing newline. A failing test inside a fixture is expected; a missing or unparsable JSON file is an error. The work directory is deleted afterwards (`--keep` leaves it).

**To add a fixture:** make the directory, write `fixture.json` and the tests, run `pnpm provino-harness record packages/harness/fixtures/<area>/<behaviour>` from the repo root (or `pnpm provino-harness record` for all), read the golden, and commit it. To change a golden, re-record it and say why in the commit. CI runs `provino-harness record --check`, which exits 1 on drift.

## Commands (from the repo root)

- `pnpm test --filter @provino/harness`: unit tests (`src/**/*.test.ts`). They never start Jest or Vitest.
- `pnpm provino-harness record [--check] [<dir>...]`: record or check goldens.
- `pnpm test:types`, `pnpm test:types:ts5.9`: `test/types.test-d.ts` (Track 12's type tests plus misuse cases).

## Gotchas

- **Jest runs fixtures as CommonJS.** No ESM-to-CommonJS transform is installed (`babel-jest` alone only hoists `jest.mock`), so an `import` in a Jest fixture crashes the file (`Must use import to load ES Module`). In `*.jest.test.ts` use `require('./helper.ts')` (with an `as` type); `jest.mock` is hoisted above it. In `*.vitest.test.ts` use `import` and `vi.mock`. A shared `*.test.ts` can use globals only.
- **Node below 22.18** needs `NODE_OPTIONS=--experimental-strip-types`: the Jest child loads the `.ts` transformer through `require()`, and it inherits the environment. Not run on 22.15 here (Node 24.22 and 26.12 were).
- **`ExperimentalWarning: stripTypeScriptTypes`** appears on Node 24.22 in Jest's stderr. Harmless; the recorder shows the runner's output tail only when no JSON was written.
- **Biome skips `__goldens__/`** through the nested `biome.json` here. Without it `pnpm format` reflows the arrays and `--check` reports drift.
- Jest's `--json` assertions carry `numPassingAsserts` and `failureDetails[i].matcherResult.name`, but its types omit them, so the converter reads them from `unknown`. Jest's file-level `message` prints paths relative to the root (`a.test.ts:7:23`); `userFrame` becomes `<root>/a.test.ts:7:23` either way.
- Jest `pending` is `it.skip`, `xit` and tests left out by `.only` or `-t`; the JSON can't say which, so `skipReason` is `unknown`. `focused` is a **file** status (passed, some tests didn't run).
- Neither JSON carries console output, so `console` is absent in converted runs and goldens. `crashed` files take their `fileError` from the file-level message.
- Files in a converted run are sorted by path (runners list them in completion order); tests stay in declaration order.
- Vitest may print `ERROR: failed to copy trust settings of system certificate` on macOS. It is stderr noise.
- `diffRuns` drops an exclusion per diff kind, not per test: an excluded `message` diff never hides a `status` diff on the same test. Console compares per test only when both runs attribute any; the concurrent-test multiset rule (R1) needs a marker the model doesn't carry yet.
