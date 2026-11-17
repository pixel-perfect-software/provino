---
"@provino/types": minor
"@provino/dialect-jest": minor
"provino": minor
---

Jest's `v8` coverage provider for `provino jest`. `coverageProvider: 'v8'` collects V8's coverage in each worker and converts it as Jest 30.5's v8 provider does (`v8-to-istanbul`, with `@bcoe/v8-coverage`'s merge of every worker's take), so the reports, `coverage-summary.json` and the text report carry Jest's numbers; a file no test loaded is reported at zero over its whole size, as Jest does. `ExecutedModuleInfo` carries the transformed `code` V8 counted and the `map` back to the source, which the coordinator converts from.
