---
"provino": patch
"@provino/types": patch
---

`provino jest` checks what a `jest.mock` factory references only in a file babel-jest transformed, as Jest does: the out-of-scope check is babel-plugin-jest-hoist's, which only babel-jest runs. A project whose transform is `@swc/jest`, ts-jest or another transformer that hoists by itself now runs a factory that reads `window` or a module-scope variable, where it failed with `The module factory of jest.mock() is not allowed to reference any out-of-scope variables`. `NeutralTransform` and `SerializedTransform` gain `checksMockFactories` (absent means no), which the Jest dialect sets for babel-jest's rules.
