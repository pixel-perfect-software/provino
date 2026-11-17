---
"@provino/transform": minor
---

The transform pipeline runs a coverage instrumenter. A request with `instrument: true` is instrumented after TypeScript is stripped (or after the project's transformer, unless it reports `canInstrument` and was given `instrument: true`) and before the hoister, with the map the earlier steps composed; the instrumenter's `name` is part of the cache fingerprint. `HostedSource` gains `canInstrument`. A request with `instrument: true` and no `instrumenter` is still `TRANSFORM_OPTION_UNSUPPORTED`.
