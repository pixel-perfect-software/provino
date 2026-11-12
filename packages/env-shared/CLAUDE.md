# @provino/env-shared

What the DOM environments share (T8.2, B17c). Layer 2, worker side, depends on `@provino/types` only. `@provino/env-node` also uses it (D71). The Jest adapter (`@provino/dialect-jest/runtime`'s `fromJestEnvironment`, T8.5) and the DOM environments (Part 2) use it; this package names no DOM library.

## `populateGlobal(global, win, options)`

Vitest 5.0.5's `populateGlobal`: the keys copied are the built-in list (`src/vendor/vitest/jsdom-keys.ts`, vendored; see its `UPSTREAM.md`) plus the window's own names, minus `window`, `self`, `top` and `parent`; a key already on the global is copied only if it is on the list. Each is a write-through accessor (`get` reads the window or a value the test set, `set` stores it and writes it to the window); `bindFunctions` binds non-class-like functions to the window (happy-dom needs it). Then `window`, `self`, `top`, `parent` (and `global`, when it exists) are the global, and `document.defaultView` is the global.

It captures **descriptors, never values** (reading `localStorage` can warn), for every own key it redefines. `restore()` deletes every populated key and defines each original descriptor again, so the global's own names and every descriptor are as they were. Two differences from Vitest: `window`, `self`, `top`, `parent` and `global` are captured too, and any own key about to be redefined is captured, not only listed ones.

The check is `src/populate.test.ts`: a jsdom window and a happy-dom `GlobalWindow` populated onto a fresh vm global that has data, accessor and symbol keys, restored, and the names and descriptors deep-equal.

## `snapshotProperties(target)` (D71)

The descriptor-exact global restore, moved from `@provino/env-node`: `@provino/env-node` and the Jest adapter share it. It captures every own key with its descriptor (reading descriptors until a pass finds no new key, which loads undici's lazy globals), wraps the setter of each configurable get/set accessor (`process`, `Buffer`, `performance`) so an assignment records the old value, and `restore()` deletes added keys, replays the wrapped setters, redefines changed keys and returns the keys it could not restore (never throws). A non-configurable symbol that graceful-fs or undici defines once per process (`graceful-fs.queue`, `undici.*`) is not reported. Tested on plain objects by `src/restore.test.ts`; the rules are in `@provino/env-node`'s CLAUDE.md.

## Not here

Environment classes, jsdom or happy-dom setup, the error-event bridge: Part 2 (`@provino/env-jsdom`).
