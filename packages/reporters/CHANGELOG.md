# @provino/reporters

## 0.1.0-rc.6

### Patch Changes

- Updated dependencies [984aef2]
  - @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Minor Changes

- 37b668a: `provino run` and `provino jest` gain `--tree` and `--map`, which print a folder tree of the run and a status map of every file in Provino's own output. With no reporter named they choose the `provino` reporter, and beside other named reporters they are a usage error.

### Patch Changes

- 7f05c04: The `provino` reporter, Provino's own live output, is what an interactive terminal gets when no reporter is named, under `provino run` and `provino jest`: a terminal that is not CI, not an agent's and not `TERM=dumb`, outside watch mode and without `--verbose`. Pipes, CI, agents, editors, watch mode, `--verbose` and any named reporter keep Jest's text. `ReporterChoice` gains `'provino'` and `['provino', { tree?, map? }]` (the views come later) and the reserved `'html'` and `['html', { outputFile? }]` (a usage error until the HTML report is built). `RunOptions.emoji: false` and `--no-emoji` (also taken by `provino jest`, before Jest's parser) give plain symbols. The reporter's code is its own chunk of the bundle, loaded only when it is chosen. The cursor it hides is shown again on `exit`, so a `process.exit` (`--forceExit`, a second signal) leaves the terminal as it was.
  
  `@provino/dialect-jest`: the config reader takes `hostReporters` (`NormalizeOptions`), names it keeps bare in `reporters` and `--reporters` instead of resolving them as modules, and `jestReporterPlan` takes them as `{ hostReporters }` and plans each as a `host` step (`JestReporterStep`). A path such as `./provino` is still a module.
  
  `@provino/reporters`: the `provino` reporter keeps a file's counts when the next file starts on the same worker before it has ended, as a run in band does.
  
  The `provino` reporter's own layout carries what the flags ask for: the seed (`--showSeed`, `--randomize`) and every snapshot outcome (failed, written, updated, obsolete, obsolete or removed files) in the end card, with the command that updates them, each file's snapshot outcome under its line, and its heap after its time (`--logHeapUsage`). One rule chooses it under both commands, Jest's single-file rule included: a run of one file that rule lists keeps the listing. While it draws, the process's own writes to a terminal stdout or stderr (`--pool inline`, in band) go above the footer; its terminal is put back on a throw, before a global-setup failure is printed, and on a signal nothing else handles, which is then raised again.
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
- Updated dependencies [1f0842e]
- Updated dependencies [3a87631]
- Updated dependencies [d3d0649]
- Updated dependencies [26ed357]
- Updated dependencies [4f255d8]
- Updated dependencies [a21fdff]
  - @provino/types@0.1.0-rc.0
