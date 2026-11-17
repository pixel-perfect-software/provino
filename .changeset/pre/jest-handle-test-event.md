---
"provino": minor
"@provino/types": minor
"@provino/dialect-jest": minor
---

A custom Jest environment's `handleTestEvent` is called (T8.5): the file's run reports jest-circus's events, in circus's order and with its fields, to the environment (`setup`, the definition events, `run_start`, `run_describe_start`, `test_start`, the hooks, `test_fn_*`, `test_done`, `test_retry`, `describe_retry`, `concurrent_tests_*`, `run_finish`, `teardown`), awaited as circus awaits them. `@provino/types` gains `LifecycleEvent`, `LifecycleHookKind`, `LifecycleHookRef`, `LifecycleListener`, `LifecycleMode` and `LifecycleRef`, and `EnvironmentInstance.onTestEvent` now takes a `LifecycleEvent`; a run whose environment has no handler pays nothing. The `jest-environment` adapter passes the environment class Jest's `globalConfig`.
