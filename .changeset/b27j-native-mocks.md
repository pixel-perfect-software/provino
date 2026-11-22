---
"provino": patch
"@provino/types": patch
"@provino/policy": patch
"@provino/transform": patch
"@provino/config": patch
---

Native module mocks: a project with no dialect can `import { mock, unmock, importActual } from 'provino'`. A top-level `mock(specifier, factory?)` is hoisted above the file's imports; the factory returns the module's exports as an object (or a Promise of them) and is given `importOriginal`; no factory is an automock. `MockObjectMatcher` gains the `imported-call` kind (a named import that is the hoisted call itself), and `@provino/policy` exports `nativeHoistPolicy`, which `@provino/config` applies to a project with no dialect.
