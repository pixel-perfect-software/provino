// Preloaded with `--import` (through NODE_OPTIONS, by `runBuilt` in `support.ts`, as a `data:` URL
// of this text: plain JavaScript, no type syntax, so the child never strips types): every `require` or `import` of an Oxc native
// binding package (`@oxc-parser/binding-darwin-arm64` and the like) fails as if the optional
// dependency was never installed (T10.3: `npm i --omit=optional`, a stale lockfile, pnpm's
// `supportedArchitectures` for another platform). `native-binding.test.ts` runs the built bin
// under it, and under no other change to the install.
//
// With PROVINO_BLOCK=other it fails something that is not Oxc's instead: the import of
// `oxc-parser` throws the napi-rs loader's text for another package's binding (swc's), with that
// package's name. Provino must not report that as an Oxc problem.
import Module, { registerHooks } from 'node:module'

const BINDING = /^@oxc-(?:parser|transform|resolver)\/binding-/

const notInstalled = (specifier = '') =>
  Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })

// The bin's probe asks `require.resolve` whether a binding is installed. Node 24 runs these hooks
// for it; Node 22.15 runs them for `require()` but not `require.resolve()`, so on 22.15 the
// probe would find the bindings this hook hides. CommonJS resolution goes through
// `Module._resolveFilename` on every Node, so the binding names fail there too. (`Reflect`, because
// the internal isn't typed and this text runs as JavaScript, so it can carry no annotation.)
Reflect.set(
  Module,
  '_resolveFilename',
  new Proxy(Reflect.get(Module, '_resolveFilename'), {
    apply(resolveFilename, receiver, args) {
      const request = String(args[0])
      if (process.env.PROVINO_BLOCK !== 'other' && BINDING.test(request))
        throw notInstalled(request)
      return Reflect.apply(resolveFilename, receiver, args)
    },
  }),
)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.env.PROVINO_BLOCK === 'other') {
      // Only the import of it: the bin's probe `require.resolve`s it to look for the bindings, and
      // those are installed here.
      if (specifier === 'oxc-parser' && context.conditions.includes('import')) {
        throw new Error(
          'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.',
          { cause: new Error("Cannot find module '@swc/core-darwin-arm64'") },
        )
      }
    } else if (BINDING.test(specifier)) {
      throw notInstalled(specifier)
    }
    return nextResolve(specifier, context)
  },
})
