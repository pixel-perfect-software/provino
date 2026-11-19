---
'@provino/loader': patch
'@provino/orchestrator': patch
'@provino/types': patch
'provino': patch
---

A dependency that a package evaluated per file shares with a shared package (`react` under a component library, beside a testing library that reads `document` as it loads) is evaluated once per worker again, on a cold cache and a warm one alike, instead of in every test file. The results cache now keeps the packages each run's workers loaded natively, and the next run's workers know them before anything joins the per-file set, so a warm worker keeps shared what a cold one kept shared. The first run on a cache written before this still evaluates those dependencies per file, and writes the list for the next.

`Loader.takeLoadedExternals()`, the `loaded` argument of `Loader.reevaluateExternals`, `SerializedLoaderConfig.loadedExternals` and `fileDone.loadedExternals` carry the list.
