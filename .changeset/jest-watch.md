---
"provino": minor
"@provino/dialect-jest": minor
"@provino/types": patch
---

`provino jest --watch` and `--watchAll` run Jest 30.5.2's watch mode, which was refused: the first run at once, a run after each change on one warm pool, and the keys `a`, `f`, `o`, `p`, `t`, `q`, `w`, `c`, Enter, Esc, Ctrl+C and Ctrl+D with Jest's usage text, pattern prompts and closing lines. `--watch` outside a repository says so and exits 1, as Jest does. A change saved while a run is going starts one more run when it ends (Jest drops it). The `u` and `i` keys, third-party `watchPlugins`, and `--coverage`, `--collectTests` and `--detectOpenHandles` in watch mode are not built yet, and say so.

`@provino/dialect-jest/node` gains the watch driver (`startJestWatch` over a `JestWatchHost`) and its parts, and `OrchestratorPolicy.watch` gains `interruptedFiles` (`report`, or Jest's `drop`: what an interrupted watch run reports of the files it killed).
