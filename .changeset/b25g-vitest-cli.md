---
'@provino/dialect-vitest': minor
'@provino/orchestrator': minor
'@provino/types': minor
'provino': minor
---

The Vitest command line (`vitestCli` in `@provino/dialect-vitest/node`: Vitest 5.0.5's `parseCLI` and its checks, rebuilt) and the first of Vitest's results (`@provino/dialect-vitest/results`: `createVitestResults`, its `json` document). `provino vitest` runs a Vitest project once, as `vitest run` does, with Vitest's exit codes, `--reporter=json`, `--outputFile`, `--shard` (Vitest's split, `orchestrator.shard.fallback: 'rooted-sha1-slice'`), `--project`, `--bail`, `--passWithNoTests` and the variables Vitest's CLI sets; bare `provino` runs a Vitest project the same way. Every flag, command, reporter option and config key it does not apply is refused by name, or warned about as not applied for a config key (D183: Vitest is parked after this release).
