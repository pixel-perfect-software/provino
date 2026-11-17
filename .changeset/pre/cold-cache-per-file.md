---
'@provino/loader': patch
'provino': patch
---

A cold cache no longer leaves a worker with some packages shared that a warm run evaluates per file: everything a package learned as per-file imports is evaluated per file too, whatever else loaded it first, so a test that passes on a warm cache no longer hangs on a cold one.
