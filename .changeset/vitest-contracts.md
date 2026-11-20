---
"@provino/types": patch
"@provino/policy": patch
"@provino/dialect-jest": patch
---

The policy has three new keys for the Vitest dialect: `snapshot.mismatch` (when a snapshot mismatch fails the test), `core.definitions.extendApi` (whether `test.extend` is there) and `core.definitions.messages` (the module that words a definition error). `WorkerKey` gains an optional `dialect`, and `NeutralProject` gains `importMetaEnv`. The neutral policy and the Jest dialect behave as before: a mismatch fails at the end of the test, and the Jest dialect has no `test.extend`.
