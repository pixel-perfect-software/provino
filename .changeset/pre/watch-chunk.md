---
"provino": patch
"@provino/dialect-jest": patch
---

Watch mode loads only under `--watch` and `--watchAll`. The watch driver, Jest's watch loop, the file watcher and the watch session are one chunk of the `provino` bundle that the bin imports when one of those flags is given, so no other run reads them. `JestWatchPluginError` moved to its own module in the dialect; its export is unchanged.
