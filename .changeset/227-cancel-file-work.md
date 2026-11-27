---
'provino': patch
'@provino/types': patch
'@provino/policy': patch
'@provino/orchestrator': patch
'@provino/reporters': patch
'@provino/dialect-jest': patch
'@provino/dialect-vitest': patch
---

Work a native jsdom file left queued no longer fails its last test with `window is not defined`. When the file's window is about to close, the worker runs the file's pending `setImmediate` and 0 ms `setTimeout` work while the window is still there (at most 50 turns or 50 ms), so a React commit that lands as the test ends runs, and React's scheduler still works in the next files. Then it clears the file's `setImmediate` and `setTimeout` work that is still pending, so none of it fires into the next file. Intervals and message ports are left alone, since a package shared by the worker's files may keep them. The new policy key is `orchestrator.windowFileWork` (`drain-then-cancel` for native projects, `outlives-file` for the Jest and Vitest dialects, which keep their behaviour). A timer cleared by its numeric id or through `node:timers` no longer holds up the wait, and a timeout that fired and was `refresh()`ed is still cleared. The default reporter now prints a dependency's stack frames for an error whose every frame is a dependency's or Node's, where it used to print none; where the error happened (a GitHub Actions annotation, the `provino` reporter's location) still comes from the user's own frames only.
