---
'provino': patch
'@provino/dialect-jest': patch
'@provino/types': minor
---

`provino jest` hands a rejection Node reports after a test file's run to the process's own listeners, as Jest 30.5.2 does: jest-circus puts its error listeners on the process only while a file runs and takes the process's own off for it, so a promise chain a test leaves in a file that waits for no timer is reported after the run and goes to a listener such as the one Next.js's transformer installs, and no test fails. With no listener of the process's own, Provino still fails the test that left it (where Jest's process would die). `CorePolicy.errors.processListeners` (`alongside` neutral and Vitest, `per-file` Jest) places the listeners. Jest's `waitForUnhandledRejections` option is applied (`CorePolicy.errors.waitForUnhandledRejections`).

A package Provino loads natively for a test file now loads with Node's CommonJS loader as Provino found it, so a patch code outside the test files made to it (Next.js's require hook, which next/jest's config and transformer install) no longer reaches the package's own `require`s, as jest-runtime never calls Node's loader: a jsdom file of a Next.js app no longer fails at load with `ReferenceError: Request is not defined` when the cache is empty. `ModulePolicy.nativeLoadPatches` (`apply` neutral and Vitest, `skip` Jest).
