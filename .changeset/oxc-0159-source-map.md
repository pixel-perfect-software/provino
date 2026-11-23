---
"@provino/transform": patch
---

A source map from oxc-transform 0.159, which can list a source as `undefined`, is written with `null` there, as a v3 map has it.
