# IDE contracts: the argv each editor starts Jest with

This is the data behind `packages/harness/fixtures/ide/<editor>-<request>/fixture.json` (B23e, T11.12, D125). Each fixture runs `run.exact` (the recorder gives Jest exactly the fixture's argv, nothing of its own), so every argv below is the one **after the shell**, copied from the editor's pinned sources. No editor process runs. JetBrains is out of B23e (D126).

Sources (tarball extracts in `.refs/`, each with a `.provino-ref` holding its URL and SHA; paths below are relative to `.refs/<name>/`, lines are at that SHA):

| Name | Pin |
| --- | --- |
| `vscode-jest` | 6.4.4, `b71edf0b1b80aa22a16222775fbd37dabab3aea0`. 6.4.4 is also the latest GitHub release (checked 2026-11-14), so there is no newer stable tag to note. |
| `jest-editor-support` | 32.0.0-beta.1, `9126abd083e3b25a076e208cd110e482e9eff9b3` (the version `vscode-jest/package.json:679` depends on: `^32.0.0-beta.1`) |
| `neotest-jest` | `0e7979d51301dfae5ef839d771bd28cf593fde3f` |

**Where the code disagrees with Track 11 F7, the code wins.** The differences are collected at the end ("Differences from Track 11 F7").

## vscode-jest 6.4.4

### How the command is built

`JestProcess.start()` (`src/JestProcessManagement/JestProcess.ts:143`) asks `jest-editor-support`'s `Runner` for a command line, and `createProcess` runs it **through a shell**. The `args` array is joined with spaces into one string and handed to `spawn(cmd, [], { shell })`, so the shell removes the quotes and backslashes the extension added. The post-shell argv is what the table gives.

1. `JestProcess.ts:157-159`: `options = { noColor: false, reporters: ['default', '"<ext>/out/reporter.js"'], args: { args: ['--colors'] } }`. The reporter path is `extensionPath/out/reporter.js` (`getReporterPath`, `:118`). `noColor` is `false`, so `--no-color` is never passed.
2. The `switch (this.request.type)` at `JestProcess.ts:165-221` appends to `args` (below).
3. `Runner._getArgs()` (`jest-editor-support src/Runner.ts:83-123`) builds the line, in this order:
   1. `--testLocationInResults --json --useStderr --outputFile <outputPath>` (`:93`; `--outputFile`, not `--jsonOutputFile`, because `currentJestVersion` is the constant `20`, `src/JestExt/helper.ts:59`)
   2. `--watchAll` or `--watch` when the request is a watch request (`:94-96`)
   3. `--testNamePattern <pattern>` when set (`:97-99`)
   4. the file argument, `options.testFileNamePattern` (`:100-102`)
   5. `--coverage` if `collectCoverage === true`, `--no-coverage` if `false` (`:103-108`; vscode-jest's `collectCoverage()` defaults to `false`, `helper.ts:49-50`, so a normal run passes `--no-coverage`)
   6. `--no-color` (never, see above)
   7. `--reporters default --reporters <ext>/out/reporter.js` (`:112-116`)
   8. `options.args.args`, from step 2 (`:117-119`), starting with `--colors`
   9. when `useDashedArgs` is on, every argument that starts with `--` is rewritten camelCase to dashed, `--(\B)([A-Z])` to `-$2` then lower-cased (`:72-80`, `:120`)
4. `createProcess` (`jest-editor-support src/Process.ts:22-51`) puts `workspace.jestCommandLine` first, appends `--config <pathToConfig>` only when `pathToConfig` is set (`:25-29`; vscode-jest passes `''`, `helper.ts:64-75`, so it never is) and spawns.

`<outputPath>` is `<os.tmpdir()>/jest_runner_<suffix>.json` (`Runner.ts:66`), where `<suffix>` is `<workspace name>_<uid>` with every non-word character turned into `_` (`helper.ts:44-48`; `_2` is appended for a request in the second blocking queue, `JestProcess.ts:225`). A replay uses a relative path inside the project instead (the JSON is captured from it). Only the path's value differs.

### Environment, working directory, shell

- **Environment** (`Process.ts:31`): `{ ...process.env, ...workspace.nodeEnv }`. The spawner adds nothing of its own: no `CI`, no `NO_COLOR`, no `FORCE_COLOR`. `nodeEnv` is the `jest.nodeEnv` setting (`helper.ts:72`), empty by default. The extension host's own environment is inherited, which in VS Code has no `CI` and no TTY on the child's stdio. A replay fixture therefore sets `CI` to `"false"` (ci-info reads that as not CI) and removes the recorder's `NO_COLOR` with `"NO_COLOR": null`, since `--colors` is passed.
- **Working directory** (`Process.ts:36`): `workspace.rootPath`, which is `jest.rootPath` resolved against the workspace folder (`helper.ts:65`, `toAbsoluteRootPath` at `helper.ts:99`): the workspace root by default.
- **Shell** (`Process.ts:38`, `:42`): `shell: <jest.shell setting> || true` (`/bin/sh -c` on POSIX), `detached: true` off Windows so the process group can be killed (`Runner.closeProcess`, `Runner.ts:236-263`). A login shell (`shell: { path, args }`) writes `<cmd> \nexit $?\n` to the shell's stdin instead (`Process.ts:53-72`).
- **Debug** runs are not spawned by the extension at all: VS Code's Node debugger starts them (see "Debug").

### Request types

`<jest>` stands for the user's `jest.jestCommandLine`; `<ext>` for the extension directory; `<out>` for the results file. Every line below starts `<jest>` and has no `--config`.

| Request | Post-shell argv (after `<jest>`) | Source |
| --- | --- | --- |
| list-test-files | `--listTests --json --watchAll=false` | `src/JestExt/process-session.ts:167`; a `not-test` request replaces the whole argument list (`JestProcess.ts:218-221`, `Runner.ts:84-88`), so there is no `--outputFile`, `--reporters` or `--colors` |
| all-tests | `--testLocationInResults --json --useStderr --outputFile <out> --no-coverage --reporters default --reporters <ext>/out/reporter.js --colors --watchAll=false` | `JestProcess.ts:165-169` |
| all-tests, update snapshot | the above plus `--updateSnapshot` last | `JestProcess.ts:167-169` |
| by-file, a test file | `--testLocationInResults --json --useStderr --outputFile <out> <file> --no-coverage --reporters default --reporters <ext>/out/reporter.js --colors --watchAll=false --runTestsByPath [--updateSnapshot]` | `JestProcess.ts:171-184`: `<file>` is `options.testFileNamePattern = "<file>"` (quoted, `quoteFileName`, `:122`), so it sits before `--no-coverage`; `--runTestsByPath` comes after `--colors` |
| by-file, a non-test file (`notTestFile`) | as above, but `--findRelatedTests <file>` in place of `--runTestsByPath`, and `<file>` is not in the positional slot | `JestProcess.ts:174-176`; used when the open file is not a test file (`src/JestExt/core.ts:632-636`, `:690-695`) |
| by-file-pattern | `… --colors --watchAll=false --testPathPatterns "<regex>" [--updateSnapshot]` | `JestProcess.ts:185-192`; the option is `--testPathPatterns` when `useJest30` is on and `--testPathPattern` when not (`:139-142`); `<regex>` is `escapeRegExp(pattern)` in double quotes, which the shell strips |
| by-file-test | `--testLocationInResults --json --useStderr --outputFile <out> --testNamePattern <re> <file> --no-coverage --reporters default --reporters <ext>/out/reporter.js --colors --runTestsByPath --watchAll=false [--updateSnapshot]` | `JestProcess.ts:194-205`; `<re>` is `escapeRegExp(name)` through `shellQuote` (see below) |
| by-file-test-pattern (what the Test Explorer sends, `src/test-provider/test-item-data.ts:804-810`) | `--testLocationInResults --json --useStderr --outputFile <out> --testNamePattern <re> --no-coverage --reporters default --reporters <ext>/out/reporter.js --colors --watchAll=false --testPathPatterns <file-regex> [--updateSnapshot]` | `JestProcess.ts:206-217`; the file is `escapeRegExp(fsPath)` in quotes |
| watch-tests | `--testLocationInResults --json --useStderr --outputFile <out> --watch --no-coverage --reporters default --reporters <ext>/out/reporter.js --colors` | `JestProcess.ts:31-39`, `:239` (`runner.start(watch, watchAll)`), `Runner.ts:94-96`. No `--watchAll=false`: a watch request has no `case` in the switch |
| watch-all-tests | as watch-tests with `--watchAll` | same |
| coverage on | `--coverage` in place of `--no-coverage` (`coverageMap` is then read from the JSON) | `JestProcess.ts:129-135`, `Runner.ts:103-105`; a Test Explorer coverage run sets `request.coverage` (`test-item-data.ts:809`) |
| dashed (`jest.useDashedArgs`) | the all-tests line with `--test-location-in-results --use-stderr --output-file --watch-all=false`; `--json`, `--no-coverage`, `--reporters`, `--colors` and `--updateSnapshot` are unchanged | `Runner.ts:72-80` |

**Test name pattern.** `escapeRegExp` (`src/helpers.ts:150-159`) escapes `.*+?^${}()|[]\` with a backslash, adds `$` when `exactMatch` (a Test Explorer *test* node; a describe block is not anchored, `test-item-data.ts:801-803`) and turns newlines into `\n`. There is no leading `^`. `shellQuote` (`helpers.ts:279-317`) then backslash-escapes every shell-special character (including spaces) for `sh`, which the shell undoes: the post-shell argument is `escapeRegExp(name)` unchanged. A fixture states it that way (for `describe test` it is `describe test$`, and for `a.b` it is `a\.b$`).

**`useJest30`.** The extension tries `--testPathPatterns` or `--testPathPattern` by what Jest answers: the text `Option "testPathPattern" was replaced by "--testPathPatterns".` turns it on, `Unrecognized option "testPathPatterns". Did you mean "testPathPattern"?` turns it off, and the process is rescheduled (`src/JestExt/process-listeners.ts:16-19`, `:298-304`). Already recorded as `cli/jest-test-path-pattern` (`provino jest` refuses the singular, as Jest 30 does).

**Debug** (`src/DebugConfigurationProvider.ts:178-185`, `:112-150`). The generated launch configuration has `args: ['--runInBand', '--watchAll=false', '--testNamePattern', '${jest.testNamePattern}', '--runTestsByPath', '${jest.testFile}']`, `cwd: '${workspaceFolder}'`, and the extension substitutes the two variables: the pattern is `escapeQuotes(escapeRegExp(testName))` or `.*` (`:143-146`), the file `toFilePath(testPath)` (`:141`). The plain Jest launch config's `program` is `${workspaceFolder}/node_modules/.bin/jest` (`:202-204`). Only the older (v1) configuration also gets `env.CI = 'vscode-jest-tests'` (`:76-84`); the v2 resolver (`:116-150`) does not. Node's debugger spawns `program` with those args and no shell, so the argv is exactly `<program> <args>`.

### What the extension reads back

- **stderr** (`jest-editor-support Runner.ts:183-224`, `:268-281`): a chunk matching `/Test results written to/` makes the runner read the output file and emit `executableJSON`. Messages matching `No tests found related to files changed since …` and `^\s*Watch Usage\b` are remembered to set `noTestsFound`. Everything else is shown. `process-listeners.ts:175-177` strips the control lines `^(onRunStart|onRunComplete|onTestFileResult|Test results written to)[^\n]+\n` from the output pane, `:349-374` fires the run events on `onRunStart` (`numTotalTestSuites: N` is read by `/onRunStart: numTotalTestSuites: ((\d)+)/`, `:175`), `onTestFileResult: encountered errors` and `onRunComplete[: execError: …]`.
- **The reporter** is `src/reporter.ts:5-40`: stderr gets `onRunStart: numTotalTestSuites: <n>\r\n`, `onTestFileResult: encountered errors\r\n` per file with failures or a `testExecError`, and `onRunComplete\r\n` (or `onRunComplete: execError: <message>\r\n`). Its built text is the same file `cli/reporters-twenty` holds (`out/reporter.js`, 6.4.4).
- **list-test-files**: stdout is searched for every `^\[.*?\]$` line (`JsonArrayRegexp`, `process-listeners.ts:118`, used at `:149-159`); each is parsed as a JSON array of paths. A non-zero exit reports stderr as the error (`:141-146`).
- **Exit code**: `> 1` is an error, `1` (a test failed) is not (`process-listeners.ts:385-390`); 127 and above can retry through a login shell (`:102-108`).
- **The results file** (`updateWithData`, `src/JestExt/core.ts:862-874`; `TestResults/TestResult.ts:116-137` strips ANSI from `message` and `failureMessages`; `jest-editor-support src/test_reconciler.ts:66-181`):
  - `testResults[].name` (absolute path), `.status` (file), `.message`, `.assertionResults`
  - `assertionResults[].title`, `.fullName`, `.ancestorTitles`, `.status` (`passed`, `failed`, `pending`, `todo`; anything else is Unknown), `.failureMessages` (the first is the message; the line of the error is the number after the file's basename, `:161-165`), `.location` (`{ line, column }`, `line` is 1-based and converted to 0-based, `:101-106`)
  - matching to source is by `fullName`, `location.line` and `ancestorTitles` + `title` (`src/TestResults/match-by-context.ts:40-60`, `:120`, `:148-151`)
  - `coverageMap` (`core.ts:856-868`) for coverage overlays
- **Watch** (`process-listeners.ts:271-276`, `:353-360`): `--watch is not supported without git/hg, please use --watchAll` and `… is outside repository` are matched on stderr, and a watch run that ends is an error unless the extension stopped it.

## neotest-jest

neotest starts the command as an **argv list with no shell** (`vim.split(binary, "%s+")` then the options, `lua/neotest-jest/init.lua:550-587`), so the table is the argv as written. `<jest>` is `getJestCommand(path)` (`jest-util.lua:13-47`: the nearest `node_modules/.bin/jest`, else `jest`), or `args.jestCommand`.

### Run (file, test, nested describe)

`init.lua:516-621` and `jest-util.lua:51-68`:

```text
<jest> [--config=<cfg>] --no-coverage --verbose --json --outputFile=<tmp>.json --testNamePattern=<p> --forceExit --testLocationInResults <extra args…> <file>
```

- `--config=<cfg>` is present only when that file exists (`jest-util.lua:54-57`; `getJestConfig` finds `jest.config.{js,ts}`, `:81-96`, else the default `jest.config.js`, `init.lua:551`). The replay fixtures hold a JSON config the recorder writes, found by `--config=jest.config.json`.
- `<tmp>.json` is `async.fn.tempname() .. ".json"` (`init.lua:555`), a temp file made empty before the run (`:592`).
- `<p>` (`init.lua:524-548`):
  - file position: `.*`
  - a test or a describe: the id after the first `::` with `::` turned into a space, escaped, prefixed `^`, and for a test (not a describe) suffixed `$`; for `.each` rows, the parameters are replaced by a match-all regex (`:535-539`)
  - `util.escapeTestPattern` (`util.lua:247-262`) backslash-escapes `( ) ] [ * + - ? $ ^ / '` and **not** `.`, `|` or `\`
- `<extra args>` come from `args.extra_args` (`init.lua:578-585`).
- `<file>` is `escapeTestPattern(vim.fs.normalize(pos.path))` (`:587`), the last argument.

Examples (`describe('outer')` containing `it('adds')`; the file is `/work/a.test.ts`):

| Request | `--testNamePattern=` | Last argument |
| --- | --- | --- |
| file | `.*` | `/work/a.test.ts` |
| test | `^outer adds$` | `/work/a.test.ts` |
| nested describe | `^outer` | `/work/a.test.ts` |

- **Environment**: `getEnv(args[2].env or {})` (`init.lua:428-430`, `:619`) returns the spec's own env, which neotest merges over Neovim's. The adapter sets nothing (no `CI`, no `NO_COLOR`). Whether the process has a TTY depends on neotest's strategy (the default `integrated` strategy); neotest itself is not in `.refs/`, so that part is **not verified**. The replays run with no TTY and the recorder's `NO_COLOR`.
- **Working directory**: `getCwd(path)` returns `nil` (`init.lua:434-436`), so neotest's default applies (not verified, same reason). The replay runs in the project root, where the config sits.

### `.each` discovery (optional, `jest_test_discovery = true`)

`lua/neotest-jest/parameterized-tests.lua:55-77`. **This differs from F7 in three ways**: the placeholder, no `--outputFile`/`--config`, and the JSON comes from stdout:

```text
<jest> --no-coverage --testLocationInResults --verbose --json <file> -t @______________PLACEHOLDER______________@
```

`<file>` is the raw `file_path` (not escaped). The placeholder is `@______________PLACEHOLDER______________@` (14 underscores each side). It matches no test, so every test comes back `pending` with its location. Run through `lib.process.run(..., { stdout = true, stderr = false })`; `result.stdout` is decoded as JSON (`:81-95`).

### What neotest reads back

- Run (`parsed_json_to_results`, `init.lua:458-512`): `data.testResults[]` with `.name`; per `assertionResults[]`: `.status`, `.title` (an assertion with no title aborts with `{}`), `.ancestorTitles` (joined with `::` after the file name to make the position id, `jest-util.lua:168-179`), `.location` (stored, and `location.line` is the fallback error line, `:498`), `.failureMessages` (ANSI stripped by `cleanAnsi`, `:442-448`; the error position is the first `<file>:<line>:<col>` in the message, `:450-456`). `pending` and `todo` become `skipped` (`:479-481`). The results file is read while the run goes (`stream`, `:603-614`) and again after it (`adapter.results`, `:628-692`).
- Discovery (`getTestsByPosition`, `parameterized-tests.lua:93-116`): `testResults[].name`, `assertionResults[].location.line` (1-based, minus 1), `.title`, `.ancestorTitles`.
- The exit code is not read. Console output is the strategy's, not Jest's `console`.

## Differences from Track 11 F7

The code wins in each of these.

1. **vscode-jest argument order.** F7 lists the trailing flags in one alternation. In the code `--colors` is the first of `options.args.args`, so it comes *after* `--reporters`, and `--runTestsByPath` / `--watchAll=false` / `--findRelatedTests` / `--testPathPatterns` / `--updateSnapshot` follow it (`JestProcess.ts:157-221`, `Runner.ts:93-119`). The file, when there is one, comes before `--no-coverage`, not after the flags.
2. **vscode-jest has no `--config`.** `pathToConfig` is always `''` (`helper.ts:64-75`), so `createProcess` never appends it.
3. **Watch requests carry no `--watchAll=false`.**
4. **by-file-test sends `--runTestsByPath` before `--watchAll=false`** (`JestProcess.ts:200`), the reverse of by-file.
5. **The Test Explorer sends `by-file-test-pattern`** (`--testPathPatterns`), not `by-file-test`, for a test item (`test-item-data.ts:804-810`).
6. **The debug configuration** agrees with F7 (`program` is `node_modules/.bin/jest`); the args are as above, and `env.CI` is set only by the older (v1) config form.
7. **neotest-jest discovery** uses `@______________PLACEHOLDER______________@` (F7 wrote `@___PLACEHOLDER___@`), passes no `--outputFile` or `--config`, and reads the JSON from stdout with `-t` after the file.
8. **neotest-jest run:** `--config=` is conditional on the file existing, and the file argument is escaped by `escapeTestPattern`.
9. **Environment:** F7 does not say, and neither spawner adds `CI`, `NO_COLOR` or `FORCE_COLOR`. The `"CI": "false"` a fixture sets is the extension host's own (no) CI, not something the editor adds.
