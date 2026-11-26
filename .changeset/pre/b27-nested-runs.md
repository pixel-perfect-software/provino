---
"provino": patch
---

A test that runs Provino in its own process (`run()` on an inline pool, `provino jest -i`, a single file in band) now works when Provino itself runs that test. The inner worker used to find the outer worker's expect slot taken (`EXPECT_SLOT_TAKEN`), and every file ended "The worker finished <file> without reporting its result". It now sets aside what the outer worker holds process-wide (the expect, lazy and API slots, the process error listeners, the console capture) and puts each back as it found it when it stops, so its files' results and uncaught errors are its own.
