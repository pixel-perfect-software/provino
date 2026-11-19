---
'@provino/loader': patch
'@provino/orchestrator': patch
'@provino/types': patch
'provino': patch
---

A dependency that a package evaluated per file shares with a shared package (`react` under a component library, beside a testing library that reads `document` as it loads) is evaluated once per worker again, on a cold cache and a warm one alike, instead of in every test file. The results cache now keeps, on each test file's record, the packages that file loaded natively when it was a worker's first file, and a worker that starts with that file next time knows them before anything joins the per-file set, so it keeps shared exactly what a worker that learned its packages in that file kept shared. A first file with no such record (on a cache written before this, or one that never ran first) still evaluates those dependencies per file, and its run writes the record for the next.

`Loader.takeLoadedExternals()`, the `loaded` argument of `Loader.reevaluateExternals`, `FileJob.loadedExternals`, `FileHistory.loadedExternals` and `fileDone.loadedExternals` carry the list.
