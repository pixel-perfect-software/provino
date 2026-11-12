# @provino/env-jsdom

Provino's own jsdom environment (Track 8, T8.3's jsdom part; B17c part 3). Runs in the worker (layer 3); imports `@provino/types` and `@provino/env-shared`, and names no dialect. It serves `provino.config` and neutral projects, and is what a Vitest-dialect project with `environment: 'jsdom'` gets. **A Jest project read by `provino jest` does not reach it:** D44 sends its `jsdom` through the Jest adapter to the project's own `jest-environment-jsdom` (`provino`'s `JEST_BUILT_INS` lists only `node`).

`jsdom` is a **peer dependency** (`>=26 <31`, Track 8) and a pinned devDependency (the catalog). `prepare` imports it once per worker; a missing package is `ENV_JSDOM_NOT_INSTALLED`.

## Map

| Path | Role |
|---|---|
| `src/environment.ts` | `jsdomEnvironment` (`Environment<'jsdom', JsdomEnvironmentOptions>`, realm `worker`): `prepare`, `setup`, the error-event bridge |
| `src/errors.ts` | `JsdomEnvironmentError`: `ENV_JSDOM_NOT_INSTALLED`, `ENV_JSDOM_NOT_PREPARED`, `ENV_JSDOM_REALM_UNSUPPORTED` |

## What `setup` does

1. Builds a `JSDOM` from the options: `html` (default `<!DOCTYPE html>`), `url` (default `http://localhost:3000`), `pretendToBeVisual` (default `true`, so `requestAnimationFrame` exists), `runScripts: 'dangerously'` (Jest's and Vitest's default), `userAgent` (as `resources: { userAgent }`; jsdom 30's constructor has no `userAgent`), then the `jsdom` bag (any other constructor option) last. Its virtual console forwards to the file's `console`.
2. Bridges errors: an `error` event on the window with no listener of the test's own is prevented and sent to `process.emit('uncaughtException', error)`, where the runtime charges it (Jest's and Vitest's behaviour). `window.addEventListener`/`removeEventListener` count the test's `error` listeners.
3. Gives the window Node's `Buffer`, the fetch family (`fetch`, `Request`, `Response`, `Headers`, `AbortController`, `AbortSignal`, `URLSearchParams`) and, where it has none, `structuredClone`, `TextEncoder`/`TextDecoder` and the channel classes. `window.jsdom` is the `JSDOM`.
4. Takes a descriptor snapshot of the global (`snapshotProperties`), then `populateGlobal(globalThis, window, { bindFunctions: true })`.

`teardown` removes the error handler, closes the window, runs `populated.restore()` and then the snapshot's `restore()`, which also undoes whatever the test added or changed on the global. It returns an `EnvironmentTeardownReport` naming any key it could not restore (D22), else nothing.

## Options

`EnvironmentOptionsMap['jsdom']` in `@provino/types`: `url`, `html`, `userAgent`, `pretendToBeVisual`, `jsdom`, and `customExportConditions`. **`customExportConditions` is not read here:** the coordinator calls the policy's `orchestrator.environmentConditions` with the options, and the neutral behaviour (`@provino/policy`) returns the option when it is a list of strings, else `['browser']` for jsdom. Vitest's dialect has its own, `vitestEnvironmentConditions` (`node`, whatever the environment: recorded, `env/conditions-vitest-jsdom`).

## Not copied from Vitest

- Its `URL`, `Request` and Blob/FormData compat wrappers. A jsdom `Blob` is not accepted as a `fetch` body (Node's `fetch` cannot read it), and the window keeps jsdom's own `URL`.
- `setupVM` (realm `context`, T2.8): `setup` throws `ENV_JSDOM_REALM_UNSUPPORTED`. The `isolationDefault` for jsdom is `realm`, so until T2.8 a project must say `isolation: 'registry'`.

## Tests

- `src/environment.test.ts`: on the real global, each case synchronous and inside `guarded` (puts the touched keys back whatever `teardown` did): defaults, options, exact restore, a window per file, `window.close()`, the error bridge with and without a listener of the test's own, the Node fetch classes, the error codes.
- `test/env-jsdom.test-d.ts`: the public types. `packages/provino/test/env-jsdom.test.ts`: the environment through `run()` on forks.
- `pnpm bench:env` (`@provino/bench`) holds T8.3's bar against a raw `JSDOM` loop.
