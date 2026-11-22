---
"provino": patch
---

A project with no dialect gets Provino's own matcher table and loads nothing from Jest or Vitest: `provino run` imports `provino jest`'s code, the Jest dialect and the Vitest dialect only when a command or a config asks for them. No public signature changes.
