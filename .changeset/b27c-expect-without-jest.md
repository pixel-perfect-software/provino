---
"@provino/expect": minor
"provino": patch
---

`@provino/expect` no longer depends on `@jest/expect-utils`: its `equals` and testers are vendored from 30.5.2 and re-exported (`equals`, `iterableEquality`, `subsetEquality`, `typeEquality`, `sparseArrayEquality`, `arrayBufferEquality`, `getPath`). `@provino/expect/table` now builds `provinoExpectTable()`, Provino's own matcher table for a project with no dialect (31 matchers, 7 asymmetric matchers, values through `util.inspect`, differences through `util.diff`).
