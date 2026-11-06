// Environment and global stubs (T4.4): Vitest 5.0's `stubEnv`, `stubGlobal` and their unstubs
// (vitest `dist/chunks/index.*.js`, `createVitest`). The first stub of a name remembers its value,
// so an unstub always goes back to what was there before any stub.
import type { MockRegistry } from './registry.ts'
import type { Stubs } from './types.ts'

/**
 * The stubs for one test file. `env` is the object to stub variables on and `global` the
 * environment's global; the registry's between-test `unstub*` steps and `dispose` reach them.
 * @public
 */
export function createStubs(
  registry: MockRegistry,
  env: Record<string, string | undefined>,
  global: object = globalThis,
): Stubs {
  const stubbedEnv = new Map<string, string | undefined>()
  const stubbedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>()

  const stubs: Stubs = {
    stubEnv(name: string, value: string | undefined): Stubs {
      if (!stubbedEnv.has(name)) stubbedEnv.set(name, env[name])
      if (value === undefined) delete env[name]
      else env[name] = String(value)
      return stubs
    },
    stubGlobal(name: PropertyKey, value: unknown): Stubs {
      if (!stubbedGlobals.has(name)) {
        stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(global, name))
      }
      Object.defineProperty(global, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      })
      return stubs
    },
    unstubAllEnvs(): Stubs {
      for (const [name, original] of stubbedEnv) {
        if (original === undefined) delete env[name]
        else env[name] = original
      }
      stubbedEnv.clear()
      return stubs
    },
    unstubAllGlobals(): Stubs {
      for (const [name, original] of stubbedGlobals) {
        if (original === undefined) Reflect.deleteProperty(global, name)
        else Object.defineProperty(global, name, original)
      }
      stubbedGlobals.clear()
      return stubs
    },
  }
  registry.addStubs(stubs)
  return stubs
}
