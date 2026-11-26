# Troubleshooting

- **A flag is refused.** Provino names the flag, and the run doesn't start. Drop the flag, or use Jest for that run. [Compatibility](compatibility.md#not-in-place-yet) lists every refused flag.
- **`provino` exits naming `@oxc-…/binding-…` packages.** Your install is missing Oxc's native package for this platform, usually after `--no-optional` or `--omit=optional`. Reinstall with optional dependencies.
- **A result differs from Jest's.** Run both on that one file, then [open an issue](https://github.com/pixel-perfect-software/provino/issues) with the test (or a minimal copy of it), both outputs, and the output of `provino jest --showConfig`.
- **Something looks stale after a config change.** Run `provino jest --clearCache`, or pass `--no-cache` for one run. The cache is in `node_modules/.cache/provino`, or under the config's `cacheDirectory` if it sets one.
- **The output looks different under an AI agent.** With no reporter named, Provino chooses the compact `agent` reporter (failures and totals) when it detects an agent (`CLAUDECODE`, `AI_AGENT`, …). Pass `--verbose`, or run outside the agent, to see Jest's text.

## Native projects

- **`PROVINO_NO_WORKER_API`.** A `provino` export (`describe`, `expect`, `fn`, …) was used outside a test file that Provino is running, from a plain Node script for example. The message says `"describe" is only available inside a test file that Provino is running`, and the error has that `code`.
- **`PROVINO_NATIVE_ONLY`.** A name only a [native project](native.md) has was used in a Jest project: `fn`, `spyOn`, `replaceProperty`, `isMockFunction`, `mocks`, `timers`, `mock`, `unmock`, `importActual`, `suite`, `aroundEach`, `aroundAll`, `onTestFinished` or `onTestFailed`. The message names the `jest.*` member to use, where there is one.
- **A config error.** It is printed as `Provino: <message>` and the run exits 2: an unknown key, a `plugins` or `alsoServe` list, a `root` that isn't a directory, two projects with one name, a `setupFiles` entry that doesn't resolve (`setupFiles[0]`).
- **The exit code.** 0 when every test passes, 1 when a test fails or no test file is found (`--passWithNoTests` passes that run), 2 for a usage or config error, and 130, 143 and 129 for `SIGINT`, `SIGTERM` and `SIGHUP`.
- **A syntax error reads differently from Node's.** In a plain JavaScript file it is a `SyntaxError` with Oxc's wording and position (``Expected `}` but found `EOF` (/path/file.js:3:1)``), not V8's `Unexpected end of input`, and it has no V8 source-line header. In a TypeScript file the test file fails as `LOADER_TRANSFORM_FAILED` with Oxc's diagnostic, where Node's type stripping gives a `SyntaxError`.
