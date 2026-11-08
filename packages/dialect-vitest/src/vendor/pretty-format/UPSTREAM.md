# Vendored upstream: Vitest's `@vitest/pretty-format`

- **Repository:** https://github.com/vitest-dev/vitest (MIT, © Vitest contributors; the files carry Meta's Jest notice they were forked from)
- **Tag:** `v5.0.5`, commit `7a825db4` (DECISIONS S3; the commit is the one Track 7 names)
- **Copied:** 2026-11-08, from `.refs/vitest`
- **Compiled as its own `tsc -b` project** (`tsconfig.json` here) with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and `isolatedDeclarations` off (DECISIONS D17). Biome skips the directory (`!**/vendor`), so upstream formatting stays and a diff against a newer tag stays readable.
- **No runtime dependency.** The package's only one, `tinyrainbow`, is replaced by an inlined table (patch 2).

## Files

| File here | Source | How |
|---|---|---|
| `index.ts` | `packages/pretty-format/src/index.ts` | copied, patched |
| `collections.ts`, `types.ts` | `packages/pretty-format/src/` | copied, `.ts` on relative imports |
| `plugins/AsymmetricMatcher.ts`, `DOMCollection.ts`, `DOMElement.ts`, `Immutable.ts`, `ReactTestComponent.ts` | `packages/pretty-format/src/plugins/` | copied, `.ts` on relative imports |
| `plugins/lib/markup.ts`, `escapeHTML.ts` | `packages/pretty-format/src/plugins/lib/` | copied, `.ts` on relative imports |
| `mockSerializer.ts` | `packages/snapshot/src/port/mockSerializer.ts` | copied, its one import points at `./types.ts` |

Not copied: `plugins/ReactElement.ts` (patch 3).

## Local patches

Every patch is marked `// provino: <reason>` in the file.

1. **`.ts` on relative imports** (Node ESM resolution), in every file.
2. **`tinyrainbow` is inlined** in `index.ts`: `getColorsHighlight` reads five ANSI open/close pairs (gray, reset, yellow, cyan, green) from it, and a snapshot never sets `highlight`.
3. **`ReactElement` is left out.** The plugin needs `react-is` (19 and 18), which nobody has asked to depend on. A React element is serialized by the `ReactTestComponent` and `DOMElement` plugins only if it has their shape; otherwise it prints as the plain object it is. Only the Vitest dialect is affected, and it isn't reachable from a run until T11.16 (Phase 2). Restoring it is the import, the `plugins` entry and the two `react-is` imports.
4. **The DOM names are loose local types.** This project is compiled without the DOM lib (nothing in the repo loads it, and the DOM plugins only name `window` and a few node types), so `index.ts` reads `window` off `globalThis`, `plugins/DOMCollection.ts` declares `NamedNodeMap`, and `plugins/DOMElement.ts` declares `Element`, `Text`, `Comment` and `DocumentFragment` as loose objects (told apart by a `__kind` field, so its type guards still narrow), with one `(attr: any)`.
