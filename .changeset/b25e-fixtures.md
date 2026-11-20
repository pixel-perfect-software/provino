---
"@provino/core": patch
"@provino/lazy": patch
"@provino/types": patch
"@provino/dialect-vitest": patch
"provino": patch
---

Fixtures in core: `test.extend` (object, `[value, options]` and builder forms) and `test.override`, with `test`, `file` and `worker` scopes, `auto` and `injected` entries and cleanups after `afterEach`, under the neutral policy and the Vitest dialect (Vitest 5.0.5"s fixture errors, word for word); the Jest dialect"s `test` has neither. `LazyHost.definitions` holds each suite"s definition table, which lazy values now live in.
