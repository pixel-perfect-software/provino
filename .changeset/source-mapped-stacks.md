---
"provino": patch
"@provino/loader": patch
"@provino/orchestrator": patch
---

A failure's stack frames point at the line and column of the test file as written, as Jest's do. They used to point into the code Provino ran (the transform's output with its imports moved and rewritten, or a Jest transformer's such as `@swc/jest`), so a frame below a file's imports could be many lines off. The worker now maps every frame in a module the loader compiled through that module's source map, the first line included, and so do `--detectOpenHandles`' creating stacks and their code frames.
