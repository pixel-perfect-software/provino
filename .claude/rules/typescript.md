---
paths:
  - "packages/**/*.ts"
  - "packages/**/*.mts"
  - "packages/**/*.tsx"
---

# Package source rules

- **ESM only.** No `require` in source, no CJS output. `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- **Relative imports use the `.ts` extension** (`rewriteRelativeImportExtensions`). Cross-package imports use the package name; the `provino-source` export condition points them at `src/` for tests (DECISIONS S1).
- **`erasableSyntaxOnly`.** No `enum`, no `namespace`, no parameter properties and no other syntax that needs a transform. Our tests run on Node's type stripping.
- **`isolatedDeclarations`.** Annotate exported `const`s and the return types of exported functions. For example `export const jest: Dialect<'jest', JestOptions> = defineDialect({...})`, not a bare `defineDialect(...)`.
- **Import only what your layer allows.** Check `monorepo-architecture.md` before adding a cross-package import. Never deep-import (`@provino/x/src/...`).
- **Your slice only.** A package imports its own `*Policy` slice type, and its functions take that slice, never `Policy`. Exempt: `policy`, `config`, `orchestrator`, `dialect-*`.
- **No dialect strings in neutral packages** (`core`, `lazy`, `mock`, `timers`, `expect`, `snapshot`, `loader`, `orchestrator`, `reporters`, `config`). Never write `=== 'jest'` / `=== 'vitest'` or branch on a dialect name there; add a policy key instead. Selecting a dialect by name (CLI dispatch, config `dialect`, the bench's `--runner`) is fine.
- **Clone safety.** Any type that crosses coordinator ↔ worker must satisfy `CloneSafe<T>`. Pass behaviour as a `ModuleRef`.
- **Public API tiers.** Tag every export `@public`, `@beta` or `@internal` (TSDoc). `@internal` code lives in `src/internal/` and is not in `exports`.
- **No hidden global state.** State goes in an explicit context object or core's AsyncLocalStorage.
- **Errors carry a code.** Library errors are typed classes with a stable `code` (e.g. `LAZY_EAGER_PENDING`) so tests can assert on the code rather than on message text.
