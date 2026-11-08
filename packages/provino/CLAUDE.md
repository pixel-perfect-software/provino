# provino

The umbrella package (layer 6, composition root). B11 built its first part: `provino/node`'s `run()` and the `provino run` bin. B14c added the dialect commands: `provino jest`, `provino vitest` (refused) and bare `provino`. It names the built-ins nobody else may (`jestDialect`, `@provino/env-node`) and wires config, orchestrator and reporters together; `slices: []` in the manifest, so no source file here may name `Policy` or a slice type (the Biome rule `slice-discipline` fails the lint; reading `project.policy.report` by property access is fine).

## Map

| Path | Role |
|---|---|
| `src/node.ts` | The `provino/node` entry: `run` and the types in `src/types.ts` (`RunOptions`, `RunResult`, `ReporterChoice`, `NormalizedJsonChoiceOptions`) |
| `src/run.ts` | `run(options)`: the whole flow below |
| `src/cli.ts` | The `provino` bin (`bin` points at the `.ts`, as `provino-bench` does): `process.exitCode = await main(argv)`. Run it with `pnpm provino run --config <file>` |
| `src/internal/cli.ts` | `main(argv, io)` (dispatch on the first argument: `run`, `jest`, `vitest`, none or a first argument starting with `-` = bare), `parseRunArgs` (`node:util` `parseArgs`, strict), `USAGE` |
| `src/internal/jest-command.ts` | `runJestCommand(args, io)`: `provino jest` (see "`provino jest`") |
| `src/internal/detect.ts` | `detectProject(cwd, forced?)`: what bare `provino` runs |
| `src/internal/execute.ts` | `executeProject`: the reporters, `runProject` and the exit code of an already-resolved project, shared by `run()` and `provino jest` |
| `src/internal/built-ins.ts` | `ENVIRONMENTS`: the environments `provino` ships, as the absolute refs a worker imports |
| `src/internal/reporters.ts` | `reportersFor`: a built-in name, `['normalized-json', { outputFile?, suite? }]` or a `Reporter` object becomes a reporter; the policy's `report.defaultReporters` when none are given |
| `src/internal/describe.ts` | `usageMessage(error)`: the text for an error that means bad input (issues the message doesn't already list, and the `cause` chain, including a thrown string or object), `undefined` for any other |
| `src/internal/usage-error.ts`, `ci.ts`, `version.ts` | `UsageError` (`PROVINO_USAGE`), `isCi(env)`, this package's version (through `import.meta.resolve('provino/package.json')`; read by `reporters.ts` only when it builds the `normalized-json` reporter) |

## `run()`

Flow: check `config` and `maxWorkers` → `loadProject(config against cwd, { dialects: [jestDialect], environments: { node: env-node }, ci })` → build the reporters and the bus → `runProject` (pool kind and `maxWorkers` only when given, `cache: false` only when asked (otherwise `runProject` keeps its own default cache in `node_modules/.cache/provino`), `stderr` for the workers' own stderr) → `exitCodeFor(summary, { policy, passWithNoTests, reporterFailures })`.

- **Bad input never rejects.** A `UsageError` (no config path, `maxWorkers` not a whole number of at least 1, an unknown reporter), a `ConfigError` (with its issues and `cause` chain) and `OrchestratorError` `ORCH_BAD_PATTERN` are written to `stderr` as `Provino: <message>` and become `{ exitCode: ExitCode.UsageError (2), summary: null }`. Every other error is a bug and rejects. The pattern is checked by `runProject` before anything starts, so no reporter has said anything.
- **Output.** `default` writes to `stderr` (as Jest does, so stdout can carry the JSON); `normalized-json` writes to `outputFile` (resolved against `cwd`) or `stdout`, with `suite` the root directory's name, `runner` `provino:<dialect name, or neutral>`, `runnerVersion` this package's version, and the policy's `orchestrator.unhandledErrors`, so the file's `success` agrees with the exit code. `reportersFor` registers the built-in `normalized-json` reporter last, whatever order it was named in, so it sees every other reporter's failure before it writes. Two `normalized-json` reporters that both write to stdout, an empty `outputFile`, and an `outputFile` that resolves to a directory are usage errors (exit 2), found before the run starts. A reporter that throws fails the run (exit 1), and `run()` also says so on `stderr`, since only `default` shows reporter errors.
- **Re-entrant.** No `process.exit`, no module-level state: the pool and the cache belong to one call, so calls follow each other or overlap on different projects. A config file is read afresh on every call (`loadConfigFile` busts Node's module cache for it; the files it imports are still cached).
- `ci` defaults to `isCi(process.env)`: `CI` set, and not empty, `0` or `false`, ignoring case and spaces (`CI=FALSE` and `CI=' false '` are not CI). That is the one answer for the run: the project is loaded with it, and the `normalized-json` reporter is given the same value (`env.ci`), so the file never disagrees with `--ci`, the `ci` option or the variable. `signal` aborting ends the run with exit 130.

## `provino jest` (B14c, T11.13, U3)

`runJestCommand`: parse the arguments with the Jest dialect's own parser (`jestNodeDialect.cli`, T11.7) → read the config with `createJestConfigReader({ argv, cwd })` (find from `cwd` or `-c`; no config file means Jest's defaults over `cwd`: an inline `{}`), `resolve` and `toNeutral` → print every diagnostic (the reader's warnings, the parser's refusals and "read but not applied" warnings) → one of four modes → `resolveNeutralProject` per project (`ci` is the global config's) and then:

- **run:** `executeProject` with the pool from the global config (`maxWorkers` as Jest normalized it, `-i` is 1; `--workerThreads` is the threads pool), `-t` from `globalConfig.testNamePattern`, the request's file filters (`selectFiles`, so a filtered run still prunes the results cache against the whole set) and no cache with `--no-cache` or `cache: false`. Several projects are refused (D29, B17).
- **`--listTests`:** every project's discovered files, filtered, once each and sorted, one path per line, or a JSON array with `--json` (written to `--outputFile` when given, as Jest does). It starts no worker.
- **`--showConfig`:** `{ globalConfig, configs, version }` as JSON (keys as our reader normalized them; Jest's own output is not compared).
- **`--clearCache`:** removes the results cache directory (`node_modules/.cache/provino`) and prints `Cleared <dir>`; Jest's own `cacheDirectory` isn't used by Provino.

**Exit codes are Jest's.** A command line or config Jest refuses (a `JestCliError` or `JestConfigError`, a refused flag, a pattern that isn't a regular expression, several projects) prints Jest's text, or `Provino: <message>`, to stderr and exits with the Jest dialect's `orchestrator.exitCodes.usage` (1; the neutral value, and every non-Jest command, is 2). A failed test is `testFailureExitCode` (1), no tests found is `noTests` (1) unless `--passWithNoTests`. `test/jest-exit-codes.test.ts` runs the bin against black-box `run` goldens recorded from Jest 30.5.2.

**Bare `provino [--dialect jest|vitest] [args]`** (`detect.ts`): `--dialect` skips the search. Else a `provino.config.{ts,mts,cts,js,mjs,cjs}` in `cwd` runs as `provino run --config <it> <args>`; else the Jest config found from `cwd` (the upward walk Jest does; a `package.json` counts only with a `jest` key) or a `vitest.config.*`/`vitest.workspace.*` in `cwd` decides; both is an error naming `--dialect`; none is an error. A Vitest project is refused until T11.15/T11.16 (a `vite.config.*` with a `test` key isn't detected: it needs Vite). `provino vitest` is refused the same way. No `jest` or `vitest` bin is published (`dispatch.test.ts` reads every package's `bin`).

## The bin

`provino run --config <file> [--maxWorkers n] [--pool forks|threads|inline] [--reporter name]… [--outputFile path] [-t pattern] [--ci] [--passWithNoTests] [--no-cache]`. A missing command, an unknown command or flag, a missing `--config`, a bad value, or `--outputFile` without `--reporter normalized-json` prints the message and the usage text to stderr, exit 2. `--help` prints the usage text to stdout, exit 0. A bug prints its stack, exit 1. The bin sets `process.exitCode` and never calls `process.exit`. With forks or threads the pool has stopped every worker, so the process ends on its own (`test/cli.test.ts` runs it with a deadline). **With `--pool inline` it may not:** the worker shares the process, so a test's leaked handle (timer, socket) keeps it alive, as with Jest's `--runInBand`; `--forceExit` is T9.10.

- `-<short>=<v>` is rewritten to the long option before `parseArgs` (which would keep the `=` in the value), for every string option with a short name in the options table (today `-t` and `-c`). A repeated `--reporter` name is a usage error.
- An inline pool runs one worker (the orchestrator caps it). An inline worker doesn't capture console, so a test's `console.log` reaches stdout: use `--outputFile` for normalized-json with `--pool inline`. With forks or threads, the workers' own stdout goes to stderr.

## Tests

- `src/internal/*.test.ts`: `parseRunArgs`/`main`, `usageMessage` and `isCi`.
- `test/recorded.ts`: a harness fixture as a project to run (its files, a Jest config made of the recorder's base and the fixture's overlay) and its Jest golden. `provino` can't import `@provino/harness` (the harness depends on it), so it reads the fixtures as files.
  - `dispatch.test.ts` (T11.13): `jest`, `vitest`, bare, `--dialect`, detection, and no `jest`/`vitest` bin.
  - `list-tests.test.ts` (U2): `--listTests` (plain and `--json`) equals the set real Jest listed, on each `fixtures/discovery/*` (default globs, `testRegex`, `roots`, ignore patterns, extensions, ordered negation, path patterns, `--runTestsByPath`).
  - `jest-exit-codes.test.ts` (U3): the bin's exit code (and the lines of Jest's message the golden kept) equal Jest's for a pass, a failing test, no tests, `--passWithNoTests`, an unknown flag, `--testPathPattern`, and a config Jest refuses.
- `test/*.test.ts`: real projects generated into `$TMPDIR` as text (no `.js` is committed, D13): a Jest-style `tests/*.test.js`, a `provino.config.mjs` and a CommonJS `package.json` (`test/support.ts`: `makeProject`, `trackedProjects`, `spawnCli` with a deadline, `viewOfNormalized`). Real forks by default.
  - `run.test.ts`: `run()` (pass, fail, the exit-2 cases, no files, `-t`, both reporters, `env.ci` in the JSON, the cache, the pools, `maxWorkers`, sequential and concurrent calls, an aborted signal).
  - `cli.test.ts`: the bin as a child process.
  - `crash.test.ts`: B11's acceptance check: a test that sends its worker SIGSEGV fails that file (`workerExit` `{ type: 'signal', signal: 'SIGSEGV' }`, `FAIL` with "killed by SIGSEGV", `crashed` in the JSON), the other files pass, no worker outlives the run; through `run()` and through the bin. Skipped on win32.
  - `run.test-d.ts`: the types of `run`'s options and result.
- Test files note their worker's pid in a file under the project (`noting`) so a test can check afterwards that every worker has exited.
- Workers' own stderr goes to the `stderr` you pass. Some environments (this sandbox) print noise there at every Node start, so assert with patterns, not that stderr is empty.

## Not built yet

- The rest of `provino/node` (`createProvino()`, `resolveConfig()`, event types, a `provino/node` form of `provino jest`), the other subpaths (`.`, `/globals`, `/config`, `/reporters`, `/environment`, `/plugin`, `/jest`, `/vitest`), the tsdown build, and `provino vitest` (T11.16).
- SIGINT/SIGTERM handling and `--bail` (T9.10, B21); the other reporters and custom reporter modules (T9.7), so `--reporters`, `--json` for a run and `--outputFile` are refused; `--shard`, `--watch`, `--coverage`, `-u`, `--findRelatedTests`, `--onlyChanged` (refused by name, with their tasks); running several `projects` (D29, B17).
