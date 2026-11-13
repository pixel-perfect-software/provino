// Preloaded with `--import` (through NODE_OPTIONS): every `require` or `import` of an Oxc native
// binding package (`@oxc-parser/binding-darwin-arm64` and the like) fails as if the optional
// dependency was never installed (T10.3: `npm i --omit=optional`, a stale lockfile, pnpm's
// `supportedArchitectures` for another platform). `native-binding.test.ts` runs the built bin
// under it, and under no other change to the install.
//
// With PROVINO_BLOCK=other it fails something that is not Oxc's instead: the import of
// `oxc-parser` throws the napi-rs loader's text for another package's binding (swc's), with that
// package's name. Provino must not report that as an Oxc problem.
import { registerHooks } from 'node:module'

const BINDING = /^@oxc-(?:parser|transform|resolver)\/binding-/

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.env.PROVINO_BLOCK === 'other') {
      if (specifier === 'oxc-parser') {
        throw new Error(
          'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.',
          { cause: new Error("Cannot find module '@swc/core-darwin-arm64'") },
        )
      }
    } else if (BINDING.test(specifier)) {
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
        code: 'MODULE_NOT_FOUND',
      })
    }
    return nextResolve(specifier, context)
  },
})
