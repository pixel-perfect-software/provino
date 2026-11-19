---
'@provino/loader': patch
'@provino/orchestrator': patch
'provino': patch
---

The test file that first loads a package now evaluates it through its own registry, as a warm run and Jest do, instead of loading it natively just for that file. A package that reads or writes nothing per file is shared from the next file on, and the cache keeps that verdict for later runs.
