---
'provino': patch
'@provino/types': patch
---

A project with no dialect gets snapshots: `toMatchSnapshot`, `toMatchInlineSnapshot` (comparing a stored value), `toThrowErrorMatchingSnapshot` and `toThrowErrorMatchingInlineSnapshot` are in the native matcher table, and the `.snap` files are Jest 30.5's format, written by the vendored pretty-format, which a worker loads only on its first snapshot. `NativeRuntimeRefs` gains `snapshotPrinter` and `snapshotWriter`. Writing an inline snapshot into the source is not built yet: such a snapshot fails.
