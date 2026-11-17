---
"provino": minor
"@provino/dialect-jest": minor
"@provino/dialect-vitest": minor
"@provino/types": minor
---

`--shard=i/n` and the timings file (T9.6). `provino jest --shard` runs the files Jest runs for each shard (Jest's sha1 split, recorded from Jest 30.5.2), and `provino run --shard` splits the path-sorted files by count. With a `provino.timings.json` (`{ "version": 1, "files": { "<path>": <ms> } }`, Bun's shape; `--timings <file>` names another) every dialect cuts contiguous runs of the path-sorted files by predicted time, a file with no time counting as the median. `--update-timings` writes each file that ran, with its time, into the file and keeps every other entry, so shards merge; `provino jest` takes `--update-timings` and `--timings` too. `RunOptions` gains `shard`, `timingsFile` and `updateTimings`; `OrchestratorPolicy.shard.fallback` is now `'sha1-slice' | 'path-slice'` (Jest and Vitest `sha1-slice`, neutral `path-slice`). The results cache's record (`FileHistory`) has room for an inputs hash, a learned tier and a coverage map, and its file version is 3.

Isolation tiers (T2.11). A test file's tier is the project's, raised (never lowered) by its `@provino-isolate <none|registry|realm|process>` docblock pragma or a tier learned from an earlier run; a value that is no tier is a warning. `Loader.tierFor(testFile, sources)` takes `TierSources` and returns a `TierChoice` (the old three-argument form is gone), `WorkerKey` gains `isolation`, and a `process`-tier file runs in a worker of its own.

The `provino` bin turns on Node's compile cache in `node_modules/.cache/provino/compile` (workers inherit `NODE_COMPILE_CACHE`), except under coverage.
