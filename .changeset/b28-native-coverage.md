---
'provino': patch
'@provino/types': patch
---

`provino run --coverage` and a top-level `coverage` key in `provino.config.*` collect code coverage for a native project: V8 by default (or `istanbul`), the files that count by `include` and `exclude` globs, `reporters` (default `text` and `lcovonly`), `directory` and Jest-shaped `thresholds`. A watch run collects none and says so.
