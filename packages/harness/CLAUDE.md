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
| `src/spawn-in-group.ts`, `run-process.ts`  | `spawnInGroup` (the one process-group spawn), `exitOnSignals`, `runProcess` (spawn plus captured output)           |
| `src/environment.ts`, `runner-package.ts`  | `readRunEnvironment`, `resolveRunnerPackage`                                                                       |
| `src/jest-transform.ts`                    | Jest transformer: `module.stripTypeScriptTypes`, then `babel-jest`; not exported, `record.ts` passes its path      |
| `src/cli.ts`                               | `provino-harness record [--check] [--keep] [<fixture dir>...]`                                                     |
| `src/internal/`                            | `stack` (a failure's text parsed into message lines and frames), `paths`, `keys` (the test key's title path), `convert` (what both converters share), `recording` (completeness, leak guard, golden I/O), `stale-goldens`, `walk` (the one directory walk), `text-diff`, `runner-config`, `guards` |

## Fixture format

A fixture is a directory `fixtures/<area>/<behaviour>/` (named for the behaviour, not numbered):

- `fixture.json`: `{ "description": string, "runners": ("jest" | "vitest")[], "env"?: Record<string, string> }`. Anything else is a coded error (`HARNESS_FIXTURE_*`).
- TypeScript test files: `*.test.ts` run under **every** listed runner; `*.jest.test.ts` only under Jest; `*.vitest.test.ts` only under Vitest (for `jest.mock` vs `vi.mock`). Support files (helpers) are copied but never run. Every listed runner needs at least one test file.
- Tests use the runner globals (`describe`, `it`, `expect`, `jest`, `vi`). Type annotations are fine; the syntax must be erasable (no `enum`).
- Fixtures carry **no runner config**: the recorder writes it (see `internal/runner-config.ts`).
- `__goldens__/<runner>.json`: written by the recorder, never by hand.

## Recorder contract

`recordFixture(dir, runner, { check?, keepWorkDir? })` copies the fixture to a fresh directory under `.record/` (inside the package, so `node_modules` resolution finds the runners), writes the runner config, and runs the pinned Jest 30.5.2 / Vitest 5.0.5 with `CI=1`, `TZ=UTC`, `NO_COLOR=1`, `LANG=LC_ALL=C.UTF-8` (`LANGUAGE` and other `LC_*` removed) and the fixture's `env`. It converts the JSON, normalizes with that directory as `<root>`, and writes the golden: a `NormalizedRun` without `startedAt`, `env`, every duration and every `raw` (the runner's text holds machine paths). Keys are in a fixed order; 2-space JSON and a trailing newline. The work directory is deleted afterwards (`--keep` leaves it, check mode included); a failed cleanup never replaces the original error.

- **A failing test inside a fixture is expected; a broken run is not.** `HARNESS_RUN_INCOMPLETE` unless the result files equal the fixture's test files for that runner exactly, no file is `crashed`, no file has zero tests, and `runErrors` is empty. The message says which, with a crash's `fileError`. A missing or unparsable JSON file is `HARNESS_RUNNER_FAILED`.
- **Leak guard.** `HARNESS_GOLDEN_LEAKS_PATH` if the serialized golden contains the work dir (or its realpath), the repo root, the package dir or the home dir. Fix the normalization rule, never the golden.
- **Timeout** (2 minutes, `TIMEOUT_MS` in `record.ts`) is the harness's own deadline: the runner is spawned with `spawnInGroup`, so on timeout the whole process group gets SIGTERM, then SIGKILL after 2 s, and the run settles 0.5 s after the child exits even if a grandchild holds the pipes. The CLI calls `exitOnSignals()`, so Ctrl-C, SIGTERM and SIGHUP end it with exit code 128 + the signal number, and the exit hook in `spawnInGroup` kills the group on the way out. A grandchild that starts its own session is out of reach.
- **`--check` also fails on stale goldens:** any `__goldens__/*.json` this run did not produce (runner removed from `fixture.json`, no manifest, stray file). With directories given, only those are scanned.

**To add a fixture:** make the directory, write `fixture.json` and the tests, run `pnpm provino-harness record packages/harness/fixtures/<area>/<behaviour>` from the repo root (or `pnpm provino-harness record` for all), read the golden, and commit it. To change a golden, re-record it and say why in the commit. CI runs `provino-harness record --check`, which exits 1 on drift.

## Shared with the bench

`@provino/bench` imports these from the package entry, so there is one of each:

- `spawnInGroup(command, args, { cwd, env, stdio, timeoutMs?, deadline?, killGraceMs? })` returns `{ child, exited }`. The child leads its own process group; `exited` settles after it exited and the group is gone (members left behind get `killGraceMs`, then SIGKILL). It installs no signal handler. `exitOnSignals()` is for entry points (`cli.ts` calls it).
- `runProcess(command, args, options)` is `spawnInGroup` plus captured output (the tail, a pipe grace, `wallMs`).
- `readRunEnvironment(runners)` and `resolveRunnerPackage(name, from)` replace the recorder's and the bench's own copies; `parseJestJson` and `parseVitestJson` read the runners' JSON.

## Commands (from the repo root)

- `pnpm test --filter @provino/harness`: unit tests (`src/**/*.test.ts`). They never start Jest or Vitest.
- `pnpm provino-harness record [--check] [<dir>...]`: record or check goldens.
- `pnpm test:types`, `pnpm test:types:ts5.9`: `test/types.test-d.ts` (Track 12's type tests plus misuse cases).

## Gotchas

- **Jest runs fixtures as CommonJS.** No ESM-to-CommonJS transform is installed (`babel-jest` alone only hoists `jest.mock`), so an `import` in a Jest fixture crashes the file (`Must use import to load ES Module`). In `*.jest.test.ts` use `require('./helper.ts')` (with an `as` type); `jest.mock` is hoisted above it. In `*.vitest.test.ts` use `import` and `vi.mock`. A shared `*.test.ts` can use globals only.
- **Node below 22.18** needs `NODE_OPTIONS=--experimental-strip-types`: the Jest child loads the `.ts` transformer through `require()`, and it inherits the environment. Not run on 22.15 here (Node 24.22 and 26.12 were).
- **`ExperimentalWarning: stripTypeScriptTypes`** appears on Node 24.22 in Jest's stderr. Harmless; the recorder shows the runner's output tail only when no JSON was written.
- **Biome skips `__goldens__/`** through `!**/__goldens__` in the root `biome.json`. Without it `pnpm format` reflows the arrays and `--check` reports drift.
- Jest's `--json` assertions carry `numPassingAsserts` and `failureDetails[i].matcherResult.name`, but its types omit them, so the converter reads them from `unknown`. Jest's file-level `message` prints paths relative to the root (`a.test.ts:7:23`); `userFrame` becomes `<root>/a.test.ts:7:23` either way.
- Jest `pending` is `it.skip`, `xit` and tests left out by `.only` or `-t`; the JSON can't say which, so `skipReason` is `unknown`. `focused` is a **file** status (passed, some tests didn't run).
- Neither JSON carries console output, so `console` is absent in converted runs and goldens. `crashed` files take their `fileError` from the file-level message.
- **Test keys are unique by construction.** `testKey` joins the title path with ` › ` after escaping `\` and `›` inside each title (`keys.ts`), so different title arrays never share a key, and `dupIndex` counts tests with the same file and the same path array, as `@provino/types` documents. `describe('a', () => it('b'))` and `it('a › b')` are different tests (`a › b#0` and `a \› b#0`). `diffRuns` still throws `HARNESS_DUPLICATE_TEST_KEY` if a hand-built or foreign run repeats a key. A `null` in Vitest's `failureMessages` (`throw { status: 404 }`) becomes one error with the message `<no message>`.
- **A failed file with passing tests** (a hook after the last test) keeps its status and takes `fileError` from the file message, for both runners and both Jest shapes. When a test failed, the message repeats that failure, so there is no `fileError`.
- **Stack and frame rules.** A frame is `at <fn> (<loc>)` or `at <loc>`, with `<loc>` ending in `:line:col` or `<anonymous>`, `native`, `index N`; only the trailing run of frames is the stack (plus any run followed by a `[cause]:` or `Caused by:` line, Jest's cause chain), so frame-shaped text inside a diff stays in the message. A frame is internal if it names no file (`<anonymous>…`, `native`, `index N`, an unreadable `eval at`) or its file path matches `node:`, `node_modules/`, `jest-circus` or `vitest/dist`; the function name is not looked at. An eval frame uses its origin. `internal/stack.ts` parses a failure once into segments (split at cause lines), each with its message lines and its frames. The path rules (ansi, crlf, file-url with 1-3 slashes, root, windows) run on the whole text, the code-frame, duration and placeholder rules on the message only, so `test/tmp/` and `10s.test.ts` survive in `userFrame`.
- **Narrow rules, on purpose.** `<root>` needs a path boundary on both sides (`/home/me/work/fixture`, `/work/fixture@1` and `/work/fixture copy/` are not the root). Durations are only `(12 ms)` and a `Time: 1.2 s` line, so configured timeouts and user strings stay. `<root>\n` is only converted to `/` when a configured root is a Windows path.
- **Parity counts.** `counts.excluded` is `referenceTests - comparedTests`: tests removed from T by a status or `missing-in-candidate` exclusion. A test leaves F only when all its message-family diffs are excluded. The JSON guards check each file's status per runner, and Vitest's rejects Jest-only fields.
- Files in a converted run are sorted by path (runners list them in completion order); tests stay in declaration order.
- Vitest may print `ERROR: failed to copy trust settings of system certificate` on macOS. It is stderr noise.
- `diffRuns` drops an exclusion per diff kind, not per test: an excluded `message` diff never hides a `status` or `user-frame` diff on the same test. Console compares per test only when both runs attribute any; the concurrent-test multiset rule (R1) needs a marker the model doesn't carry yet.
