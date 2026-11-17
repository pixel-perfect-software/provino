# @provino/orchestrator

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
