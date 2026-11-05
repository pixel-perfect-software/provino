# provino

The umbrella package (layer 6, composition root). B11 built its first part: `provino/node`'s `run()` and the temporary `provino run` bin. It names the built-ins nobody else may (`jestDialect`, `@provino/env-node`) and wires config, orchestrator and reporters together; `slices: []` in the manifest, so no source file here may name `Policy` or a slice type (the Biome rule `slice-discipline` fails the lint; reading `project.policy.report` by property access is fine).

## Map

| Path | Role |
|---|---|
| `src/node.ts` | The `provino/node` entry: `run` and the types in `src/types.ts` (`RunOptions`, `RunResult`, `ReporterChoice`, `NormalizedJsonChoiceOptions`) |
| `src/run.ts` | `run(options)`: the whole flow below |
| `src/cli.ts` | The `provino` bin (`bin` points at the `.ts`, as `provino-bench` does): `process.exitCode = await main(argv)`. Run it with `pnpm provino run --config <file>` |
| `src/internal/cli.ts` | `main(argv, io)` (dispatch on the first argument, so T11.13 adds `jest` and `vitest` beside `run`), `parseRunArgs` (`node:util` `parseArgs`, strict), `USAGE` |
| `src/internal/reporters.ts` | `reportersFor`: a built-in name, `['normalized-json', { outputFile?, suite? }]` or a `Reporter` object becomes a reporter; the policy's `report.defaultReporters` when none are given |
| `src/internal/describe.ts` | `usageMessage(error)`: the text for an error that means bad input, `undefined` for any other |
| `src/internal/usage-error.ts`, `ci.ts`, `version.ts` | `UsageError` (`PROVINO_USAGE`), `isCi(env)`, this package's version (through `import.meta.resolve('provino/package.json')`) |

## `run()`

Flow: check `config` and `maxWorkers` → `loadProject(config against cwd, { dialects: [jestDialect], environments: { node: env-node }, ci })` → build the reporters and the bus → `runProject` (pool kind and `maxWorkers` only when given, `cache: false` only when asked (otherwise `runProject` keeps its own default cache in `node_modules/.cache/provino`), `stderr` for the workers' own stderr) → `exitCodeFor(summary, { policy, passWithNoTests, reporterFailures })`.

- **Bad input never rejects.** A `UsageError` (no config path, `maxWorkers` not a whole number of at least 1, an unknown reporter), a `ConfigError` (with its issues and `cause` chain) and `OrchestratorError` `ORCH_BAD_PATTERN` are written to `stderr` as `Provino: <message>` and become `{ exitCode: ExitCode.UsageError (2), summary: null }`. Every other error is a bug and rejects. The pattern is checked by `runProject` before anything starts, so no reporter has said anything.
- **Output.** `default` writes to `stderr` (as Jest does, so stdout can carry the JSON); `normalized-json` writes to `outputFile` (resolved against `cwd`) or `stdout`, with `suite` the root directory's name, `runner` `provino:<dialect name, or neutral>` and `runnerVersion` this package's version. A reporter that throws fails the run (exit 1), and `run()` also says so on `stderr`, since only `default` shows reporter errors.
- **Re-entrant.** No `process.exit`, no module-level state: the pool and the cache belong to one call, so calls follow each other or overlap on different projects. A config file is read afresh on every call (`loadConfigFile` busts Node's module cache for it; the files it imports are still cached).
- `ci` defaults to `isCi(process.env)`: `CI` set, and not empty, `0` or `false`, ignoring case and spaces (`CI=FALSE` and `CI=' false '` are not CI). That is the one answer for the run: the project is loaded with it, and the `normalized-json` reporter is given the same value (`env.ci`), so the file never disagrees with `--ci`, the `ci` option or the variable. `signal` aborting ends the run with exit 130.

## The bin

`provino run --config <file> [--maxWorkers n] [--pool forks|threads|inline] [--reporter name]… [--outputFile path] [-t pattern] [--ci] [--passWithNoTests] [--no-cache]`. A missing command, an unknown command or flag, a missing `--config`, a bad value, or `--outputFile` without `--reporter normalized-json` prints the message and the usage text to stderr, exit 2. `--help` prints the usage text to stdout, exit 0. A bug prints its stack, exit 1. The bin sets `process.exitCode` and never calls `process.exit`: the pool has stopped every worker, so the process ends on its own (`test/cli.test.ts` runs it with a deadline).

## Tests

- `src/internal/*.test.ts`: `parseRunArgs`/`main` and `isCi`.
- `test/*.test.ts`: real projects generated into `$TMPDIR` as text (no `.js` is committed, D13): a Jest-style `tests/*.test.js`, a `provino.config.mjs` and a CommonJS `package.json` (`test/support.ts`: `makeProject`, `trackedProjects`, `spawnCli` with a deadline, `viewOfNormalized`). Real forks by default.
  - `run.test.ts`: `run()` (pass, fail, the exit-2 cases, no files, `-t`, both reporters, `env.ci` in the JSON, the cache, the pools, `maxWorkers`, sequential and concurrent calls, an aborted signal).
  - `cli.test.ts`: the bin as a child process.
  - `crash.test.ts`: B11's acceptance check: a test that sends its worker SIGSEGV fails that file (`workerExit` `{ type: 'signal', signal: 'SIGSEGV' }`, `FAIL` with "killed by SIGSEGV", `crashed` in the JSON), the other files pass, no worker outlives the run; through `run()` and through the bin. Skipped on win32.
  - `run.test-d.ts`: the types of `run`'s options and result.
- Test files note their worker's pid in a file under the project (`noting`) so a test can check afterwards that every worker has exited.
- Workers' own stderr goes to the `stderr` you pass. Some environments (this sandbox) print noise there at every Node start, so assert with patterns, not that stderr is empty.

## Not built yet

- The rest of `provino/node` (`createProvino()`, `resolveConfig()`, event types), the other subpaths (`.`, `/globals`, `/config`, `/reporters`, `/environment`, `/plugin`, `/jest`, `/vitest`), the tsdown build, and `provino jest`/`provino vitest` with a `RunRequest` (T11.13, B14).
- SIGINT/SIGTERM handling and `--bail` (T9.10, B21); the other reporters and custom reporter modules (T9.7); `--listTests`, `--shard`, `--watch`.
