---
paths:
  - "packages/dialect-*/**"
---

# Dialect package rules

- **A dialect is data plus facades.** Its core is one `defineDialect({...})` value: policy overrides, detect score, options schema, config reader, CLI flags, API modules, globals, loader policies, reporter adapters and type entries. Runner-specific logic lives here and nowhere else.
- **Every policy value needs evidence.** Each value matches what the pinned upstream actually does (Jest 30.5.x, Vitest 5.0.x), backed by a ground-truth fixture in `@provino/harness` (T1.7). If you can't produce the fixture, don't add the value; ask.
- **`version` names the upstream it mirrors** (e.g. `'30.5'`). Bumping it means re-recording the ground truth.
- **Split by process.** `/node` (config reader, flags, reporter adapters) runs in the coordinator. `/runtime` (facades, globals, behaviour functions) runs in the worker. Neither imports the other.
- **Behaviour keys** (title formatting, factory shape) are exported functions referenced by `ModuleRef`, so they load once per worker.
- **Error messages users compare against** (e.g. Jest 30's `--testPathPattern` error) are copied exactly, with the source file and line noted in a comment.
- **Quirks follow DECISIONS D7.** Fix bugs. Reproduce documented behaviour. For a red-turning fix, keep the upstream outcome and warn with a fix hint.
