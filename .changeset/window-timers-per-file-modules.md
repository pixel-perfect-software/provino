---
"provino": patch
"@provino/types": patch
---

Under `provino jest` with a Jest jsdom environment class, the timers a file's own code left pending are cancelled when its window closes, as `window.close()` does in Jest, while the timers of Provino's own code (the coordinator's, in band) run as before. A shared package that owned a cancelled timer (a scheduler whose "loop running" flag only that timer's callback clears) is evaluated again in every later file, so no later file meets its stale state.

`EnvironmentTeardownReport` gains `perFileModules`: the shared modules a file left holding its own work, which the worker evaluates per file from then on.
