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
// @ts-expect-error resolve has no such key
defineConfig({ resolve: { conditon: ['x'] } })
