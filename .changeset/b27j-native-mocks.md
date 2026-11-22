---
"provino": patch
"@provino/types": patch
"@provino/policy": patch
"@provino/transform": patch
"@provino/config": patch
---

Native module mocks: a project with no dialect can `import { mock, unmock, importActual } from 'provino'`. A top-level `mock(specifier, factory?)` is hoisted above the file's imports; the factory returns the module's exports as an object (or a Promise of them) and is given `importOriginal`; no factory is an automock. `HoistPolicy` gains the optional `importedCalls` (named imports that are hoisted calls themselves) and `NativeRuntimeRefs` the optional `hoist`; both are additions no existing value has to change for. `@provino/policy` exports `nativeHoistPolicy(module)` and `NATIVE_HOISTED_CALLS`.
