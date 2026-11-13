# Why Provino

Most of the time a large Jest suite spends isn't spent running tests. It goes on work repeated for every test file:
- evaluating the module graph again, `node_modules` included;
- building the test environment again and re-running setup files;
- pushing source through Babel.

Jest gives each file a fresh module environment that nothing can share. That's what makes its isolation safe, and also what makes big suites slow.

The faster runners each ask you to change something first:
- **Vitest** needs Vite and has its own API (`vi`, its own config, different defaults), so moving a large Jest suite over is a migration.
- **Bun's test runner** needs the Bun runtime.
- **Node's built-in `node:test`** has no `expect`, and its module mocks are still experimental.

**Provino aims to be the faster runner you don't migrate to.** You point it at the Jest project you have, and you keep your config, command line, matchers, snapshot files and exit codes. It aims to be faster through the way it's built, without giving up isolation:

- **Your modules are fresh in every test file; `node_modules` isn't.** Each file gets a new registry for your own code, while third-party modules are evaluated once per worker and shared. A file that needs everything fresh can ask for a stricter isolation tier with an `@provino-isolate` docblock.
- **Warm work is kept:**
  - workers are reused across files;
  - transformed code goes into a persistent cache;
  - Node's compile cache and V8's code cache skip recompiling.
- **Oxc compiles TypeScript and JSX instead of Babel.** Oxc is a Rust toolchain. Your project's own transformers (`babel-jest`, `ts-jest`, `@swc/jest`) still run when its config names them.
- **Matching Jest is checked, not assumed.** Every place where Jest and Vitest behave differently is a typed policy value. Each value is checked against goldens recorded from the real Jest 30.5 and Vitest 5.0, and every deliberate difference is recorded.

## The bar

Provino's go/no-go line, on the reference suites:
- at most half of Jest's time on a warm run;
- at most 80% of it on a cold run;
- at least 90% of tests getting the same result as Jest.

That bar is a target, not a result. Results will come from benchmarks on pinned hardware, which are pending; numbers from a developer's laptop are signals, not results.

## After the bar

- `provino vitest` for Vitest projects.
- RSpec-style lazy variables as the default way to define test values.
- A Rust core for discovery, resolution, transforms and scheduling.
