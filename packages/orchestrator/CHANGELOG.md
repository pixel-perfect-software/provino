# @provino/orchestrator

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
