# @provino/config

## 0.1.0-rc.6

### Patch Changes

- Updated dependencies [984aef2]
  - @provino/types@0.1.0-rc.6
  - @provino/policy@0.1.0-rc.6
  - @provino/transform@0.1.0-rc.6

## 0.1.0-rc.5

### Patch Changes

- @provino/policy@0.1.0-rc.5
  - @provino/transform@0.1.0-rc.5
  - @provino/types@0.1.0-rc.5

## 0.1.0-rc.4

### Patch Changes

- @provino/policy@0.1.0-rc.4
  - @provino/transform@0.1.0-rc.4
  - @provino/types@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- @provino/policy@0.1.0-rc.3
  - @provino/transform@0.1.0-rc.3
  - @provino/types@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- Updated dependencies [d015c8e]
  - @provino/types@0.1.0-rc.2
  - @provino/policy@0.1.0-rc.2
  - @provino/transform@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- @provino/policy@0.1.0-rc.1
  - @provino/transform@0.1.0-rc.1
  - @provino/types@0.1.0-rc.1

## 0.1.0-rc.0

### Patch Changes

- e1ac91d: `provino jest --projects a b` (or a config's `projects`) no longer fails with Node's `ERR_INTERNAL_ASSERTION` when the projects share a CommonJS custom `resolver`, such as `ts-jest-resolver`. The Jest dialect loads what a Jest config names as jest-util's `requireOrImportModule` does: a plain `require` (an `import()` for `.mjs`/`.mts`, or when `require` refuses an ES module), so a config, reporter, watch plugin or results processor loads once per process, and a custom resolver is loaded once per process by its real path and shared by every project, as jest-resolve's `preloadedResolvers` is. A preset is still read afresh for each project, as Jest deletes it from `require.cache` first. Before, each project imported the resolver afresh at the same time, and a second fresh load of a CommonJS file removed its entry from Node's module cache while Node was still loading the first.
  
  A resolver that throws as it loads is `JEST_CONFIG_RESOLVER_LOAD_FAILED`, with a message that names the resolver and the first line of what it threw, and what it threw as the `cause`, and `provino jest` prints that error's stack, as jest-cli does. `@provino/config` no longer exports `importConfigModule` (only `loadConfigFile` called it, and its `withoutDefault` option, which served Jest's resolver, is gone): the `provino.config.*` loader runs fresh loads of one file (by its real path) one after another, so two runs that overlap on one config can't meet the same assertion.
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
