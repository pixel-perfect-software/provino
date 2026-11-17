---
"provino": patch
---

`provino jest` says so when it finds no Jest config and directories below the root have one. At a monorepo root with a `package.json` that has no `jest` key, Jest (and so Provino) runs every package's tests over its defaults. When that is the case and the run's test files lie under directories with their own `jest.config.*` or `jest` key, one line goes to stderr before the run: `provino: no Jest config here; 2 directories below have one (apps/client, packages/ui). Run with --projects <dirs> to use them.` (at most five named). It is left out under `--json`, `--listTests`, `--showConfig`, `--collectTests`, `--debug` and `--watch`, and when `--config`, `--projects` or a root config is in use. Jest prints nothing there.
