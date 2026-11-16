---
"provino": patch
"@provino/types": patch
---

A fork or thread worker whose heap is over the memory limit (`workerIdleMemoryLimit` under `provino jest`, `--workerMemoryLimit` under `provino run`) collects garbage once and measures again, and is replaced only if it is still over. jest-worker compares the heap as it is, so a worker that holds only garbage a file left behind is replaced there and kept here. The files each worker runs and `JEST_WORKER_ID` are unchanged, so a test can't tell. A project whose shared modules are expensive to load in each worker no longer pays for a replacement that freed nothing. A limit of `0` still replaces the worker after every file and collects nothing.

`WorkerInit` gains `memoryLimitBytes`: the limit the pool compares `fileDone.memoryBytes` with, set for forks and threads only.
