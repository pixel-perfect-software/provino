// Preloaded with `--import` (through NODE_OPTIONS): every `require` or `import` of an Oxc native
// binding package (`@oxc-parser/binding-darwin-arm64` and the like) fails as if the optional
// dependency was never installed (T10.3: `npm i --omit=optional`, a stale lockfile, pnpm's
// `supportedArchitectures` for another platform). `native-binding.test.ts` runs the built bin
// under it, and under no other change to the install.
import { registerHooks } from 'node:module'

const BINDING = /^@oxc-(?:parser|transform|resolver)\/binding-/

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (BINDING.test(specifier)) {
      throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
        code: 'MODULE_NOT_FOUND',
      })
    }
    return nextResolve(specifier, context)
  },
})
