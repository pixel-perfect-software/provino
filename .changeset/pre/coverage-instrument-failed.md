---
"@provino/types": minor
"@provino/transform": minor
---

`TransformErrorCode` gains `COVERAGE_INSTRUMENT_FAILED`: a file the coverage instrumenter cannot read comes back with that error diagnostic and its code unchanged, on a transformer's files as on the Oxc path (a file that already has an error diagnostic is not instrumented). A request with `instrument: true` and no `instrumenter` is `TRANSFORM_OPTION_UNSUPPORTED` for a transformer's file too, unless the transformer reports `canInstrument`.
