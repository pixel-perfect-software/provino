---
"@provino/types": minor
---

Coverage collection types. `SerializedCoverageConfig` names the test-file globs, regular expressions and ignore patterns separately (`testFiles`, `testRegex`, `testIgnorePatterns`); the V8 arm of `RawCoverage` carries the compiled `modules` its scripts are of; `LoaderOptions.shouldInstrument` tells the loader which user modules the transformer instruments; `CompiledModuleEvent.transformKey` is required; and `Loader.compiledModule(url)` answers with the code V8 compiled, its wrapper length and the map back to the source.
