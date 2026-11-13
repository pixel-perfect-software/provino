# How Provino works

**One neutral core runs the tests.** It never asks which runner it's imitating. Every place where Jest and Vitest behave differently is a typed *policy* value supplied by a *dialect*, and each runner's API (`jest` or `vi`, `expect`, the globals) is that dialect's facade. A dialect is a value made of four things:
- policy values;
- a config reader;
- a command-line parser;
- those facades.

`provino jest` is the Jest dialect on the neutral core.

**A coordinator and a pool of workers.** The coordinator discovers the test files and orders them: Jest's order, or contiguous shards by recorded time. A pool of workers runs them. A worker is a child process, a worker thread, or the coordinator's own process. Behaviour crosses from the coordinator to a worker as a reference to a module, never as a function.

**Isolation.** Each file gets a fresh registry for your own modules and its own test environment. Third-party modules under `node_modules` are evaluated once per worker and shared. A file can ask for a stricter tier with an `@provino-isolate` docblock, and the tier can be raised but never lowered. Under the `process` tier, the file gets a worker of its own.

**Transforms and caches.**
- Oxc compiles TypeScript and JSX, unless the project's config names its own transformers, which run as Jest runs them.
- `jest.mock` calls are hoisted at compile time and substituted when modules load.
- Transformed code is cached on disk, and Node's compile cache and V8's code cache skip recompiling.

**Ground truth.** The values Provino claims match Jest 30.5 or Vitest 5.0 are checked against fixtures recorded from the real runners; `pnpm test --filter @provino/harness` runs the checks. A few values are still waiting for a recording. The tests also run real Jest beside Provino on the same projects and compare each test's result.
