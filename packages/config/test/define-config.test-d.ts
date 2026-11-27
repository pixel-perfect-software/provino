import { defineConfig } from '@provino/config'
import type { ConfigEnv, ProvinoConfigInput } from '@provino/types'
import { expectTypeOf } from 'expect-type'

// An object keeps its type.
const object = defineConfig({ include: ['a'], timeouts: { test: 50 }, pool: 'forks' })
expectTypeOf(object.timeouts.test).toEqualTypeOf<50>()

// A function's env is typed, and it may be async.
defineConfig((env) => {
  expectTypeOf(env).toEqualTypeOf<ConfigEnv>()
  return { name: env.mode }
})
defineConfig(async () => ({ resolve: { conditions: ['provino-source'], tsconfig: false } }))
expectTypeOf(defineConfig({})).toExtend<ProvinoConfigInput>()
defineConfig({ projects: ['packages/*', { name: 'inline', include: ['t/**'] }] })

// @ts-expect-error an unknown key is an error
defineConfig({ incude: ['a'] })
// @ts-expect-error timeouts are numbers
defineConfig({ timeouts: { test: '50' } })
// @ts-expect-error a pool is forks, threads or inline
defineConfig({ pool: 'cluster' })
// @ts-expect-error an inline project has no pool of its own
defineConfig({ projects: [{ pool: 'forks' }] })
defineConfig({ execArgv: ['--conditions=provino-source', '--require', './setup.cjs'] })
// @ts-expect-error execArgv is a list of flags, not one string
defineConfig({ execArgv: '--conditions=provino-source' })
// @ts-expect-error an inline project has no execArgv of its own
defineConfig({ projects: [{ execArgv: ['--x'] }] })
// @ts-expect-error resolve has no such key
defineConfig({ resolve: { conditon: ['x'] } })

// define: a string is source text, any other JSON value is its JSON text.
defineConfig({
  define: {
    'import.meta.env.DEV': true,
    'import.meta.env.MODE': '"test"',
    __COUNT__: 3,
    'import.meta.env': { DEV: true, BASE_URL: '/' },
  },
})
defineConfig({ projects: [{ name: 'a', define: { X: null } }] })
// @ts-expect-error a function is not a JSON value
defineConfig({ define: { X: () => 1 } })
// @ts-expect-error define is an object, not a list
defineConfig({ define: ['X'] })
// @ts-expect-error define is an object, not a string
defineConfig({ define: 'X' })
