import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Environment, EnvironmentRef } from '@provino/types'
import { WorkerError } from '../errors.ts'
import { importEnvironment, prepareEnvironment, setupEnvironment } from './environment.ts'

/** A `data:` module exporting `source`'s declarations, so a test needs no file for an environment. */
const ref = (
  source: string,
  name = 'env',
  options: EnvironmentRef['options'] = {},
): EnvironmentRef => ({
  module: `data:text/javascript,${encodeURIComponent(source)}`,
  export: name,
  options,
})

const good =
  'export const env = { name: "e", realms: ["worker"], setup: () => ({ global: {}, teardown() {} }) }'

const rejects = (promise: Promise<unknown>) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof WorkerError && error.code === 'ORCH_BAD_ENVIRONMENT',
  )

describe('importEnvironment', () => {
  it('reads the export the ref names', async () => {
    const environment = await importEnvironment(ref(good))
    assert.equal(environment.name, 'e')
  })

  it('refuses a module that cannot be imported, with the cause', async () => {
    await assert.rejects(importEnvironment(ref('throw new Error("boom")')), (error: unknown) => {
      assert.ok(error instanceof WorkerError && error.code === 'ORCH_BAD_ENVIRONMENT')
      assert.equal((error.cause as Error).message, 'boom')
      return true
    })
  })

  it('refuses an export that is missing or not an environment', async () => {
    await rejects(importEnvironment(ref(good, 'other')))
    await rejects(importEnvironment(ref('export const env = 3')))
    await rejects(importEnvironment(ref('export const env = { name: "e", realms: ["worker"] }')))
    await rejects(
      importEnvironment(ref('export const env = { name: 1, realms: ["worker"], setup() {} }')),
    )
    await rejects(
      importEnvironment(ref('export const env = { name: "e", realms: "worker", setup() {} }')),
    )
    await rejects(
      importEnvironment(
        ref('export const env = { name: "e", realms: ["worker"], setup() {}, prepare: 1 }'),
      ),
    )
  })

  it('refuses an environment without the worker realm', async () => {
    await rejects(
      importEnvironment(ref('export const env = { name: "e", realms: ["context"], setup() {} }')),
    )
  })
})

describe('prepareEnvironment and setupEnvironment', () => {
  it('calls prepare once with the options, and passes its result to every setup', async () => {
    const calls: string[] = []
    const loaded = {
      environment: {
        name: 'e',
        realms: ['worker'],
        prepare(options) {
          calls.push(`prepare ${JSON.stringify(options)}`)
          return { token: 1 }
        },
        setup(context, prepared) {
          calls.push(`setup ${context.scope} ${context.realm} ${JSON.stringify(prepared)}`)
          return { global: globalThis, teardown() {} }
        },
      } satisfies Environment<string, EnvironmentRef['options']>,
      options: { a: 1 },
      prepared: { token: 1 },
    }
    const context = {
      scope: 'file',
      testPath: '/t.ts',
      pragmas: {},
      console,
      signal: new AbortController().signal,
    } as const
    await setupEnvironment(loaded, context)
    await setupEnvironment(loaded, { ...context, scope: 'worker' })
    assert.deepEqual(calls, ['setup file worker {"token":1}', 'setup worker worker {"token":1}'])
  })

  it('awaits an async prepare, and an environment without one prepares to undefined', async () => {
    const withPrepare = await prepareEnvironment(
      ref(
        'export const env = { name: "e", realms: ["worker"], setup() {}, prepare: async (o) => o.n }',
        'env',
        { n: 7 },
      ),
    )
    assert.equal(withPrepare.prepared, 7)
    assert.deepEqual(withPrepare.options, { n: 7 })
    assert.equal((await prepareEnvironment(ref(good))).prepared, undefined)
  })

  it('refuses an instance without a global object or a teardown', async () => {
    const context = {
      scope: 'file',
      testPath: '/t.ts',
      pragmas: {},
      console,
      signal: new AbortController().signal,
    } as const
    for (const instance of [
      undefined,
      {},
      { global: {} },
      { global: null, teardown() {} },
      { teardown() {} },
    ]) {
      const loaded = {
        environment: {
          name: 'e',
          realms: ['worker'],
          setup: () => instance,
        } as unknown as Environment<string, EnvironmentRef['options']>,
        options: {},
        prepared: undefined,
      }
      await rejects(setupEnvironment(loaded, context))
    }
  })
})
