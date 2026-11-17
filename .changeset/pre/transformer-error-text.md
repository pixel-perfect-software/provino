---
"provino": patch
"@provino/types": patch
---

`provino jest` fails a file whose project transformer throws with the transformer's own error, as Jest does: its class and message as thrown, with no second copy of the path in front (`ReferenceError: <file>: …`, not `LoaderError: <file>: <file>: …`), and a thrown string as the string. `TransformDiagnostic` gains `thrown` (the class name of what a hosted transformer threw, `null` for a thrown string).
