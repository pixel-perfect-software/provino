---
"@provino/loader": patch
"@provino/transform": patch
---

A syntax error in a module the loader runs is a `SyntaxError`, as Node gives it, with the parser's message and position, and the transform's error as its `cause`. `TransformError.parse` says when a transform failure is the parser's report of a syntax error.
