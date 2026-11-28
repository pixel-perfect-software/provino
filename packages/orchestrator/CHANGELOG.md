# @provino/orchestrator

## 0.1.0-rc.14

### Patch Changes

- Updated dependencies [f8d64af]
  - @provino/policy@0.1.0-rc.14
  - @provino/loader@0.1.0-rc.14
  - @provino/config@0.1.0-rc.14
  - @provino/core@0.1.0-rc.14
  - @provino/expect@0.1.0-rc.14
  - @provino/mock@0.1.0-rc.14
  - @provino/snapshot@0.1.0-rc.14
  - @provino/timers@0.1.0-rc.14
  - @provino/coverage@0.1.0-rc.14
  - @provino/lazy@0.1.0-rc.14
  - @provino/rpc@0.1.0-rc.14
  - @provino/types@0.1.0-rc.14

## 0.1.0-rc.13

### Patch Changes

- ad3db57: A native worker puts its timer wrappers on the global only when it runs a jsdom file. Before, every native worker wrapped `setTimeout`, `setImmediate` and their clears at start, so a project on the `node` environment paid for the wrapper on every timer call. Now the first jsdom file of a worker installs them once its window is set up, before any of its modules load, and a `node` worker keeps Node's own timer functions. Under `--pool inline` and a run in band, where the workers share one process and its packages, each worker still installs them as it starts, so work a jsdom project queues through a package a `node` project loaded first is still drained with its window. A `--detectOpenHandles` report no longer shows Provino's frames, the wrapper's included, above the project's own call, even when an installed copy of Provino other than the one collecting the handles made the frame.
- Updated dependencies [ad3db57]
  - @provino/types@0.1.0-rc.13
  - @provino/config@0.1.0-rc.13
  - @provino/core@0.1.0-rc.13
  - @provino/coverage@0.1.0-rc.13
  - @provino/expect@0.1.0-rc.13
  - @provino/lazy@0.1.0-rc.13
  - @provino/loader@0.1.0-rc.13
  - @provino/mock@0.1.0-rc.13
  - @provino/policy@0.1.0-rc.13
  - @provino/rpc@0.1.0-rc.13
  - @provino/snapshot@0.1.0-rc.13
  - @provino/timers@0.1.0-rc.13

## 0.1.0-rc.12

### Patch Changes

- 22f6272: Work a native jsdom file left queued no longer fails its last test with `window is not defined`. When the file's window is about to close, the worker runs the file's pending `setImmediate` and 0 ms `setTimeout` work while the window is still there (at most 50 turns or 50 ms), so a React commit that lands as the test ends runs, and React's scheduler still works in the next files. Then it clears the file's `setImmediate` and `setTimeout` work that is still pending, so none of it fires into the next file. Intervals and message ports are left alone, since a package shared by the worker's files may keep them. The new policy key is `orchestrator.windowFileWork` (`drain-then-cancel` for native projects, `outlives-file` for the Jest and Vitest dialects, which keep their behaviour). A timer cleared by its numeric id or through `node:timers` no longer holds up the wait, and a timeout that fired and was `refresh()`ed is still cleared. The default reporter now prints a dependency's stack frames for an error whose every frame is a dependency's or Node's, where it used to print none; where the error happened (a GitHub Actions annotation, the `provino` reporter's location) still comes from the user's own frames only.
- Updated dependencies [22f6272]
  - @provino/types@0.1.0-rc.12
  - @provino/policy@0.1.0-rc.12
  - @provino/config@0.1.0-rc.12
  - @provino/core@0.1.0-rc.12
  - @provino/coverage@0.1.0-rc.12
  - @provino/expect@0.1.0-rc.12
  - @provino/lazy@0.1.0-rc.12
  - @provino/loader@0.1.0-rc.12
  - @provino/mock@0.1.0-rc.12
  - @provino/rpc@0.1.0-rc.12
  - @provino/snapshot@0.1.0-rc.12
  - @provino/timers@0.1.0-rc.12

## 0.1.0-rc.11

### Patch Changes

- 514f338: A native config takes a `define` key: compile-time replacements in the project's own modules, as a bundler's `define` makes them, so a module that reads `import.meta.env.DEV` or `process.env.NODE_ENV` runs without the runner emulating a bundler.
- b2ab699: Projects of a `provino.config.*` may share a root when their `include` globs select different files, so some files of one `src/` can run in node and others in jsdom. A run is refused (exit 2) only when a file would run in more than one project, and the message names the projects and the files. In a watch session a new file that makes an overlap fails that run, not the session.
  
  Behaviour change: projects whose roots nest (for example `.` and `packages/a`) and that both select one file used to run it twice without a word; the run is now refused, so give their `include` globs no file in common.
- Updated dependencies [514f338]
- Updated dependencies [bb82b45]
- Updated dependencies [8660a21]
- Updated dependencies [cfb5974]
- Updated dependencies [b2ab699]
  - @provino/config@0.1.0-rc.11
  - @provino/types@0.1.0-rc.11
  - @provino/loader@0.1.0-rc.11
  - @provino/expect@0.1.0-rc.11
  - @provino/policy@0.1.0-rc.11
  - @provino/core@0.1.0-rc.11
  - @provino/coverage@0.1.0-rc.11
  - @provino/lazy@0.1.0-rc.11
  - @provino/mock@0.1.0-rc.11
  - @provino/rpc@0.1.0-rc.11
  - @provino/snapshot@0.1.0-rc.11
  - @provino/timers@0.1.0-rc.11

## 0.1.0-rc.10

### Patch Changes

- 4a3ad73: A dependency that Node loads itself (an ES module in `node_modules`) can import a subpath of a package with no `exports` map without its extension, as `import { NextResponse } from 'next/server'` does: the worker resolves it as `require` would. Before, the test file failed to load with "Cannot find module … Did you mean to import …?".
- Updated dependencies [4a3ad73]
- Updated dependencies [43cab28]
- Updated dependencies [b4b4581]
- Updated dependencies [921fde7]
  - @provino/loader@0.1.0-rc.10
  - @provino/policy@0.1.0-rc.10
  - @provino/types@0.1.0-rc.10
  - @provino/mock@0.1.0-rc.10
  - @provino/config@0.1.0-rc.10
  - @provino/core@0.1.0-rc.10
  - @provino/expect@0.1.0-rc.10
  - @provino/snapshot@0.1.0-rc.10
  - @provino/timers@0.1.0-rc.10
  - @provino/coverage@0.1.0-rc.10
  - @provino/lazy@0.1.0-rc.10
  - @provino/rpc@0.1.0-rc.10

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
  - @provino/types@0.1.0-rc.9
  - @provino/config@0.1.0-rc.9
  - @provino/core@0.1.0-rc.9
  - @provino/coverage@0.1.0-rc.9
  - @provino/expect@0.1.0-rc.9
  - @provino/lazy@0.1.0-rc.9
  - @provino/loader@0.1.0-rc.9
  - @provino/mock@0.1.0-rc.9
  - @provino/policy@0.1.0-rc.9
  - @provino/rpc@0.1.0-rc.9
  - @provino/snapshot@0.1.0-rc.9
  - @provino/timers@0.1.0-rc.9

## 0.1.0-rc.8

### Patch Changes

- Updated dependencies [4534450]
  - @provino/types@0.1.0-rc.8
  - @provino/config@0.1.0-rc.8
  - @provino/core@0.1.0-rc.8
  - @provino/coverage@0.1.0-rc.8
  - @provino/expect@0.1.0-rc.8
  - @provino/lazy@0.1.0-rc.8
  - @provino/loader@0.1.0-rc.8
  - @provino/mock@0.1.0-rc.8
  - @provino/policy@0.1.0-rc.8
  - @provino/rpc@0.1.0-rc.8
  - @provino/snapshot@0.1.0-rc.8
  - @provino/timers@0.1.0-rc.8

## 0.1.0-rc.7

### Minor Changes

- 9f7b73d: The Vitest command line (`vitestCli` in `@provino/dialect-vitest/node`: Vitest 5.0.5's `parseCLI` and its checks, rebuilt) and the first of Vitest's results (`@provino/dialect-vitest/results`: `createVitestResults`, its `json` document). `provino vitest` runs a Vitest project once, as `vitest run` does, with Vitest's exit codes, `--reporter=json`, `--outputFile`, `--shard` (Vitest's split, `orchestrator.shard.fallback: 'rooted-sha1-slice'`), `--project`, `--bail`, `--passWithNoTests` and the variables Vitest's CLI sets; bare `provino` runs a Vitest project the same way. Every flag, command, reporter option and config key it does not apply is refused by name, or warned about as not applied for a config key (D183: Vitest is parked after this release).

### Patch Changes

- ce31acb: Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
- 334af48: `WatchSessionOptions.configFile`: the config file's path, a project input to the affected index (under the neutral policy a change to it selects every test) and a path the watcher reports whatever the crawl keeps.
- Updated dependencies [28c95d9]
- Updated dependencies [5a4dce2]
- Updated dependencies [9f7b73d]
- Updated dependencies [7daea04]
- Updated dependencies [c730222]
- Updated dependencies [d0821a2]
- Updated dependencies [021f020]
- Updated dependencies [6002b7a]
- Updated dependencies [26b1b86]
- Updated dependencies [ce31acb]
- Updated dependencies [ba5e5f7]
- Updated dependencies [ecc8972]
- Updated dependencies [55de21e]
- Updated dependencies [c2970a6]
  - @provino/core@0.1.0-rc.7
  - @provino/lazy@0.1.0-rc.7
  - @provino/types@0.1.0-rc.7
  - @provino/config@0.1.0-rc.7
  - @provino/expect@0.1.0-rc.7
  - @provino/loader@0.1.0-rc.7
  - @provino/policy@0.1.0-rc.7
  - @provino/coverage@0.1.0-rc.7
  - @provino/snapshot@0.1.0-rc.7
  - @provino/mock@0.1.0-rc.7
  - @provino/rpc@0.1.0-rc.7
  - @provino/timers@0.1.0-rc.7

## 0.1.0-rc.6

### Patch Changes

- Updated dependencies [984aef2]
  - @provino/loader@0.1.0-rc.6
  - @provino/config@0.1.0-rc.6
  - @provino/core@0.1.0-rc.6
  - @provino/coverage@0.1.0-rc.6
  - @provino/expect@0.1.0-rc.6
  - @provino/lazy@0.1.0-rc.6
  - @provino/mock@0.1.0-rc.6
  - @provino/policy@0.1.0-rc.6
  - @provino/rpc@0.1.0-rc.6
  - @provino/snapshot@0.1.0-rc.6
  - @provino/timers@0.1.0-rc.6
  - @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- Updated dependencies [fb1e2ad]
  - @provino/timers@0.1.0-rc.5
  - @provino/config@0.1.0-rc.5
  - @provino/core@0.1.0-rc.5
  - @provino/coverage@0.1.0-rc.5
  - @provino/expect@0.1.0-rc.5
  - @provino/lazy@0.1.0-rc.5
  - @provino/loader@0.1.0-rc.5
  - @provino/mock@0.1.0-rc.5
  - @provino/policy@0.1.0-rc.5
  - @provino/rpc@0.1.0-rc.5
  - @provino/snapshot@0.1.0-rc.5
  - @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- Updated dependencies [ed9eb4e]
  - @provino/loader@0.1.0-rc.4
  - @provino/config@0.1.0-rc.4
  - @provino/core@0.1.0-rc.4
  - @provino/coverage@0.1.0-rc.4
  - @provino/expect@0.1.0-rc.4
  - @provino/lazy@0.1.0-rc.4
  - @provino/mock@0.1.0-rc.4
  - @provino/policy@0.1.0-rc.4
  - @provino/rpc@0.1.0-rc.4
  - @provino/snapshot@0.1.0-rc.4
  - @provino/timers@0.1.0-rc.4
  - @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- Updated dependencies [49bb02a]
  - @provino/loader@0.1.0-rc.3
  - @provino/config@0.1.0-rc.3
  - @provino/core@0.1.0-rc.3
  - @provino/coverage@0.1.0-rc.3
  - @provino/expect@0.1.0-rc.3
  - @provino/lazy@0.1.0-rc.3
  - @provino/mock@0.1.0-rc.3
  - @provino/policy@0.1.0-rc.3
  - @provino/rpc@0.1.0-rc.3
  - @provino/snapshot@0.1.0-rc.3
  - @provino/timers@0.1.0-rc.3
  - @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2
  - @provino/config@0.1.0-rc.2
  - @provino/core@0.1.0-rc.2
  - @provino/coverage@0.1.0-rc.2
  - @provino/expect@0.1.0-rc.2
  - @provino/lazy@0.1.0-rc.2
  - @provino/loader@0.1.0-rc.2
  - @provino/mock@0.1.0-rc.2
  - @provino/policy@0.1.0-rc.2
  - @provino/rpc@0.1.0-rc.2
  - @provino/snapshot@0.1.0-rc.2
  - @provino/timers@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/config@0.1.0-rc.1
  - @provino/core@0.1.0-rc.1
  - @provino/coverage@0.1.0-rc.1
  - @provino/expect@0.1.0-rc.1
  - @provino/lazy@0.1.0-rc.1
  - @provino/loader@0.1.0-rc.1
  - @provino/mock@0.1.0-rc.1
  - @provino/policy@0.1.0-rc.1
  - @provino/rpc@0.1.0-rc.1
  - @provino/snapshot@0.1.0-rc.1
  - @provino/timers@0.1.0-rc.1
  - @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Patch Changes

- dbb0604: A failure's stack frames point at the line and column of the test file as written, as Jest's do. They used to point into the code Provino ran (the transform's output with its imports moved and rewritten, or a Jest transformer's such as `@swc/jest`), so a frame below a file's imports could be many lines off. The worker now maps every frame in a module the loader compiled through that module's source map, the first line included, and so do `--detectOpenHandles`' creating stacks and their code frames.
- Updated dependencies [063753f]
- Updated dependencies [dbe800f]
- Updated dependencies [e79a080]
- Updated dependencies [f6e0ab6]
- Updated dependencies [73dbb1b]
- Updated dependencies [983f094]
- Updated dependencies [0b12a9f]
- Updated dependencies [7c3711a]
- Updated dependencies [4feaef4]
- Updated dependencies [a9571da]
- Updated dependencies [26ed357]
- Updated dependencies [26ed357]
- Updated dependencies [ddb10bf]
- Updated dependencies [646c3e3]
- Updated dependencies [646c3e3]
- Updated dependencies [475232b]
- Updated dependencies [e1ac91d]
- Updated dependencies [5ec4d3b]
- Updated dependencies [209f097]
- Updated dependencies [3872fb2]
- Updated dependencies [14850e9]
- Updated dependencies [c5230cd]
- Updated dependencies [493ebff]
- Updated dependencies [929e910]
- Updated dependencies [09fc2b2]
- Updated dependencies [a43cb01]
- Updated dependencies [f7a629d]
- Updated dependencies [f7a629d]
- Updated dependencies [a602762]
- Updated dependencies [dd8b08f]
- Updated dependencies [cf22585]
- Updated dependencies [e33f3ad]
- Updated dependencies [cffb867]
- Updated dependencies [9a55f65]
- Updated dependencies [2da1a4b]
- Updated dependencies [d464f91]
- Updated dependencies [133727f]
- Updated dependencies [a56ca80]
- Updated dependencies [3872fb2]
- Updated dependencies [6186141]
- Updated dependencies [fe9ad4f]
- Updated dependencies [a2764b2]
- Updated dependencies [dbb0604]
- Updated dependencies [1f0842e]
- Updated dependencies [3a87631]
- Updated dependencies [d3d0649]
- Updated dependencies [26ed357]
- Updated dependencies [4f255d8]
- Updated dependencies [a21fdff]
  - @provino/types@0.1.0-rc.0
  - @provino/policy@0.1.0-rc.0
  - @provino/config@0.1.0-rc.0
  - @provino/lazy@0.1.0-rc.0
  - @provino/loader@0.1.0-rc.0
  - @provino/core@0.1.0-rc.0
  - @provino/coverage@0.1.0-rc.0
  - @provino/expect@0.1.0-rc.0
  - @provino/mock@0.1.0-rc.0
  - @provino/rpc@0.1.0-rc.0
  - @provino/snapshot@0.1.0-rc.0
  - @provino/timers@0.1.0-rc.0
