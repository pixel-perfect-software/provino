---
'provino': patch
---

A native project can stand in a global or an environment variable for one test with `stubGlobal`, `stubEnv`, `unstubAllGlobals` and `unstubAllEnvs`, including a global Node lacks (`location`) or has as a getter (`navigator`), which `replaceProperty` refuses. Each stand-in is put back before the next test.
