---
"provino": minor
"@provino/types": minor
---

The built-in reporters beside `default` (T9.7): `verbose`, `dot`, `agent`, `json` (the `NormalizedRun`, also `normalized-json`), `junit` and `github-actions`, named with `--reporter` or in `run()`'s `reporters`, and exported from `provino/reporters` with `detectOutput` (a terminal, CI, an agent, colour) and `createStyle`. With no reporter named, an agent (`CLAUDECODE`, `AI_AGENT`, ...) gets `agent` and GitHub Actions adds `github-actions`; colour follows the terminal, `FORCE_COLOR` and `NO_COLOR`. `RunOptions` gains `env`, `ReporterChoice` the new names and `JUnitChoiceOptions`, and `RunRequest` gains `colour` (Jest's `--color`, `--colors` and `--no-color`).
