# @provino/env-jsdom

## 0.1.0-rc.0

### Minor Changes

- 475232b: The first built packages: each ships ESM and declarations in `dist`, and its API is reported in `etc/` and checked by `pnpm hygiene`. `provino` gains the `.`, `/globals`, `/config`, `/reporters`, `/environment` and `/jest` entry points beside `/node`, and a `--version` flag.

### Patch Changes

- 9a55f65: Each test file gets its own `process`, as Jest gives it: a copy of the worker's with listeners of its own and a copy of `env`, so an `exit`, `uncaughtException` or `SIGINT` listener a file (or its setup file) adds never reaches the next file in the worker and never runs at the worker's exit, a setup file that adds an `exit` listener per file no longer prints `MaxListenersExceededWarning`, and a file's `process.env` changes stay in the file. The `orchestrator` policy slice gains `processObject` (`'per-file' | 'shared'`: Jest and neutral `per-file`, Vitest `shared`), and `EnvironmentSetupContext` gains `processObject`, which `nodeEnvironment`, `jsdomEnvironment` and the Jest environment adapter read.
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
  - @provino/env-shared@0.1.0-rc.0
