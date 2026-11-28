---
"provino": patch
"@provino/orchestrator": patch
"@provino/types": patch
---

A native worker puts its timer wrappers on the global only when it runs a jsdom file. Before, every native worker wrapped `setTimeout`, `setImmediate` and their clears at start, so a project on the `node` environment paid for the wrapper on every timer call. Now the first jsdom file of a worker installs them once its window is set up, before any of its modules load, and a `node` worker keeps Node's own timer functions. Under `--pool inline` and a run in band, where the workers share one process and its packages, each worker still installs them as it starts, so work a jsdom project queues through a package a `node` project loaded first is still drained with its window. A `--detectOpenHandles` report no longer shows Provino's frames, the wrapper's included, above the project's own call, even when an installed copy of Provino other than the one collecting the handles made the frame.
