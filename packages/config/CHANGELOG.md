# @provino/config

## 0.1.0-rc.12

### Patch Changes

- Updated dependencies [22f6272]
  - @provino/types@0.1.0-rc.12
  - @provino/policy@0.1.0-rc.12
  - @provino/resolver@0.1.0-rc.12
  - @provino/transform@0.1.0-rc.12

## 0.1.0-rc.11

### Patch Changes

- 514f338: A native config takes a `define` key: compile-time replacements in the project's own modules, as a bundler's `define` makes them, so a module that reads `import.meta.env.DEV` or `process.env.NODE_ENV` runs without the runner emulating a bundler.
- 8660a21: A native project's jsdom has `matchMedia`, `scrollIntoView`, `animate`, `ResizeObserver` and a client rect for a displayed element, so a setup file no longer writes them. Turn them off with `environmentOptions: { standIns: false }`.
- cfb5974: A native project can import an asset or a style file. `import logo from './logo.svg'` is the file's URL as a Vite dev server writes it (`/src/logo.svg`, or `/@fs/<path>` outside the project root), a `.css` or `.scss` import is an empty module, and a `*.module.css` import is an object that answers each name with itself. `?raw` imports the file's text and `?url` its URL. A `mock()` of the file still wins, so does a transform the project configures for it, and a dependency's own asset or stylesheet import works too. Projects on the Jest or Vitest dialect are unchanged.
- b2ab699: Projects of a `provino.config.*` may share a root when their `include` globs select different files, so some files of one `src/` can run in node and others in jsdom. A run is refused (exit 2) only when a file would run in more than one project, and the message names the projects and the files. In a watch session a new file that makes an overlap fails that run, not the session.
  
  Behaviour change: projects whose roots nest (for example `.` and `packages/a`) and that both select one file used to run it twice without a word; the run is now refused, so give their `include` globs no file in common.
- Updated dependencies [514f338]
- Updated dependencies [bb82b45]
- Updated dependencies [8660a21]
- Updated dependencies [cfb5974]
  - @provino/types@0.1.0-rc.11
  - @provino/policy@0.1.0-rc.11
  - @provino/transform@0.1.0-rc.11
  - @provino/resolver@0.1.0-rc.11

## 0.1.0-rc.10

### Patch Changes

- Updated dependencies [43cab28]
- Updated dependencies [921fde7]
  - @provino/policy@0.1.0-rc.10
  - @provino/transform@0.1.0-rc.10
  - @provino/types@0.1.0-rc.10
  - @provino/resolver@0.1.0-rc.10

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [6e68b21]
- Updated dependencies [6e68b21]
  - @provino/types@0.1.0-rc.9
  - @provino/policy@0.1.0-rc.9
  - @provino/resolver@0.1.0-rc.9
  - @provino/transform@0.1.0-rc.9

## 0.1.0-rc.8

### Patch Changes

- 4534450: A native `provino.config.*` takes a top-level `execArgv`: the Node flags each forked or threaded worker starts with (`['--conditions=development']`), added after the coordinator's own. It is top level only (a project in `projects` refuses it), and an `inline` pool or an in-band run ignores it.
- Updated dependencies [4534450]
  - @provino/types@0.1.0-rc.8
  - @provino/policy@0.1.0-rc.8
  - @provino/resolver@0.1.0-rc.8
  - @provino/transform@0.1.0-rc.8

## 0.1.0-rc.7

### Patch Changes

- 7daea04: The contracts for Provino-native projects (B27, D184 to D186). `ProvinoConfigInput` gains `timeouts`, `resolve` (`conditions`, `aliases`, `tsconfig`), `environmentOptions`, and the run keys `pool` and `maxWorkers`; `setupFiles` may name a package. `ProvinoConfig` is what `defineConfig` will take. These are types only for now: until a later release reads them, a config that sets one is refused with `CONFIG_UNSUPPORTED`. `NativeRuntimeRefs` and `ResolveProjectOptions.native` carry the native runtime's matcher table, served modules and globals for a project with no dialect.
- ce31acb: Error and help messages no longer name internal task ids. A non-empty `plugins` or `alsoServe` says `config key "plugins" isn't supported yet`; `provino --help` no longer says that a build loads the Jest dialect's code or points at the task that builds a refused flag; and the "not implemented yet", "not supported yet" and "not applied" texts of `provino run`, `provino jest` and `provino vitest`, the loader, the environments, core, the orchestrator, coverage, the transform and the inline snapshot matchers drop their task and decision references.
- ba5e5f7: Native module mocks: a project with no dialect can `import { mock, unmock, importActual } from 'provino'`. A top-level `mock(specifier, factory?)` is hoisted above the file's imports; the factory returns the module's exports as an object (or a Promise of them) and is given `importOriginal`; no factory is an automock. `HoistPolicy` gains the optional `importedCalls` (named imports that are hoisted calls themselves) and `NativeRuntimeRefs` the optional `hoist`; both are additions no existing value has to change for. `@provino/policy` exports `nativeHoistPolicy(module)` and `NATIVE_HOISTED_CALLS`.
- Updated dependencies [28c95d9]
- Updated dependencies [5a4dce2]
- Updated dependencies [9f7b73d]
- Updated dependencies [7daea04]
- Updated dependencies [c730222]
- Updated dependencies [021f020]
- Updated dependencies [6002b7a]
- Updated dependencies [26b1b86]
- Updated dependencies [ce31acb]
- Updated dependencies [ba5e5f7]
- Updated dependencies [5713e8e]
- Updated dependencies [30b872f]
- Updated dependencies [ecc8972]
- Updated dependencies [55de21e]
- Updated dependencies [c2970a6]
  - @provino/types@0.1.0-rc.7
  - @provino/policy@0.1.0-rc.7
  - @provino/transform@0.1.0-rc.7
  - @provino/resolver@0.1.0-rc.7

## 0.1.0-rc.6

### Patch Changes

- @provino/policy@0.1.0-rc.6
  - @provino/transform@0.1.0-rc.6
  - @provino/types@0.1.0-rc.6

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
