---
'@provino/loader': patch
'provino': patch
---

A test run with a warm cache now evaluates per file only what a cold run does, so warm runs are faster and match cold ones. A dependency that a package evaluated per file shares with a shared package (`react` under a component library, beside a testing library that reads `document` as it loads) is evaluated once per worker again, instead of in every test file.
