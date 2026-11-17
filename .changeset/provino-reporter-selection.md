---
"provino": minor
"@provino/dialect-jest": minor
"@provino/reporters": patch
---

The `provino` reporter, Provino's own live output, is what an interactive terminal gets when no reporter is named, under `provino run` and `provino jest`: a terminal that is not CI, not an agent's and not `TERM=dumb`, outside watch mode and without `--verbose`. Pipes, CI, agents, editors, watch mode, `--verbose` and any named reporter keep Jest's text. `ReporterChoice` gains `'provino'` and `['provino', { tree?, map? }]` (the views come later) and the reserved `'html'` and `['html', { outputFile? }]` (a usage error until the HTML report is built). `RunOptions.emoji: false` and `--no-emoji` (also taken by `provino jest`, before Jest's parser) give plain symbols. The reporter's code is its own chunk of the bundle, loaded only when it is chosen. The cursor it hides is shown again on `exit`, so a `process.exit` (`--forceExit`, a second signal) leaves the terminal as it was.

`@provino/dialect-jest`: the config reader takes `hostReporters` (`NormalizeOptions`), names it keeps bare in `reporters` and `--reporters` instead of resolving them as modules, and `jestReporterPlan` takes them as `{ hostReporters }` and plans each as a `host` step (`JestReporterStep`). A path such as `./provino` is still a module.

`@provino/reporters`: the `provino` reporter keeps a file's counts when the next file starts on the same worker before it has ended, as a run in band does.

The `provino` reporter's own layout carries what the flags ask for: the seed (`--showSeed`, `--randomize`) and every snapshot outcome (failed, written, updated, obsolete, obsolete or removed files) in the end card, with the command that updates them, each file's snapshot outcome under its line, and its heap after its time (`--logHeapUsage`). One rule chooses it under both commands, Jest's single-file rule included: a run of one file that rule lists keeps the listing. While it draws, the process's own writes to a terminal stdout or stderr (`--pool inline`, in band) go above the footer; its terminal is put back on a throw, before a global-setup failure is printed, and on a signal nothing else handles, which is then raised again.
