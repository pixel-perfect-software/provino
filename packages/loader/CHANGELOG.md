# @provino/loader

## 0.1.0-rc.6

### Patch Changes

- 984aef2: A test run with a warm cache now evaluates per file only what a cold run does, so warm runs are faster and match cold ones. A dependency that a package evaluated per file shares with a shared package (`react` under a component library, beside a testing library that reads `document` as it loads) is evaluated once per worker again, instead of in every test file.
- @provino/policy@0.1.0-rc.6
  - @provino/resolver@0.1.0-rc.6
  - @provino/transform@0.1.0-rc.6
  - @provino/types@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- @provino/policy@0.1.0-rc.5
  - @provino/resolver@0.1.0-rc.5
  - @provino/transform@0.1.0-rc.5
  - @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- ed9eb4e: The first test file to load a package with a `browser` build (Emotion under jsdom, through MUI) now gets the environment's build from that first load, as later files and Jest do, rather than Node's build alongside it.
- @provino/policy@0.1.0-rc.4
  - @provino/resolver@0.1.0-rc.4
  - @provino/transform@0.1.0-rc.4
  - @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- 49bb02a: A cold cache no longer leaves a worker with some packages shared that a warm run evaluates per file: everything a package learned as per-file imports is evaluated per file too, whatever else loaded it first, so a test that passes on a warm cache no longer hangs on a cold one.
- @provino/policy@0.1.0-rc.3
  - @provino/resolver@0.1.0-rc.3
  - @provino/transform@0.1.0-rc.3
  - @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2
  - @provino/policy@0.1.0-rc.2
  - @provino/resolver@0.1.0-rc.2
  - @provino/transform@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/policy@0.1.0-rc.1
  - @provino/resolver@0.1.0-rc.1
  - @provino/transform@0.1.0-rc.1
  - @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Patch Changes

- e33f3ad: A CommonJS test or module can call `import()`: it loads through the file's own module registry, where it used to throw `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `import.meta` has no prototype, as Node's, and `import.meta.resolve` answers a relative, absolute or `file:` specifier it can't find with the URL it names, as Node does (a missing package still throws). The loader's semantics are now checked against native Node, case by case (live bindings, cycles, top-level await, `import.meta`, `import()`, `require(esm)`, `__esModule` under both interops, JSON, a shared `.node` addon, `require.cache`, re-evaluation after a failure); the differences that remain are listed as divergences. The test runtime costs less per test (about 7 µs to 5 µs for an empty test with three hooks): the test context's keys are plain properties, as Vitest's are, so they are now writable.
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
  - @provino/transform@0.1.0-rc.0
  - @provino/policy@0.1.0-rc.0
  - @provino/resolver@0.1.0-rc.0
