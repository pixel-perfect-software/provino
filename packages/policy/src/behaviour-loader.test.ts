import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { EnvironmentConditions, ModuleRef, SnapshotKey } from '@provino/types'
import { callBehaviour, createBehaviourLoader, type ModuleImporter } from './behaviour-loader.ts'
import { PolicyError } from './errors.ts'
import { moduleRef } from './module-ref.ts'
import { neutralPolicy } from './neutral.ts'

function countingImporter(namespace: Readonly<Record<string, unknown>>): {
  readonly importModule: ModuleImporter
  readonly calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    importModule: async (specifier) => {
      calls.push(specifier)
      return namespace
    },
  }
}

describe('callBehaviour', () => {
  test('loads a ModuleRef once, however often it is called', async () => {
    const { importModule, calls } = countingImporter({ key: (n: string, c: number) => `${n}/${c}` })
    const loader = createBehaviourLoader({ importModule })
    const ref = moduleRef<SnapshotKey>('file:///dialect/runtime.ts', 'key')
    const results = await Promise.all([1, 2, 3].map((n) => callBehaviour(loader, ref, 'name', n)))
    results.push(await callBehaviour(loader, ref, 'name', 4))
    assert.deepEqual(results, ['name/1', 'name/2', 'name/3', 'name/4'])
    assert.deepEqual(calls, ['file:///dialect/runtime.ts'])
  })

  test('two exports of one module share one import', async () => {
    const { importModule, calls } = countingImporter({ a: () => 'a', b: () => 'b' })
    const loader = createBehaviourLoader({ importModule })
    assert.equal(await callBehaviour(loader, moduleRef<() => string>('m', 'a')), 'a')
    assert.equal(await callBehaviour(loader, moduleRef<() => string>('m', 'b')), 'b')
    assert.deepEqual(calls, ['m'])
  })

  test('each loader has its own cache', async () => {
    const { importModule, calls } = countingImporter({ a: () => 'a' })
    const ref = moduleRef<() => string>('m', 'a')
    await callBehaviour(createBehaviourLoader({ importModule }), ref)
    await callBehaviour(createBehaviourLoader({ importModule }), ref)
    assert.deepEqual(calls, ['m', 'm'])
  })

  test('a closure is called directly, with no import', async () => {
    const { importModule, calls } = countingImporter({})
    const loader = createBehaviourLoader({ importModule })
    const key: SnapshotKey = (name, n) => `${name}:${n}`
    assert.equal(await callBehaviour(loader, key, 'x', 2), 'x:2')
    assert.deepEqual(calls, [])
  })

  test('an async behaviour is awaited', async () => {
    const loader = createBehaviourLoader({ importModule: async () => ({ f: async () => 42 }) })
    assert.equal(await callBehaviour(loader, moduleRef<() => Promise<number>>('m', 'f')), 42)
  })

  test('a missing or non-function export throws POLICY_BEHAVIOUR_NOT_FUNCTION', async () => {
    const loader = createBehaviourLoader({ importModule: async () => ({ value: 1 }) })
    for (const name of ['value', 'missing']) {
      await assert.rejects(callBehaviour(loader, moduleRef<() => void>('m', name)), {
        code: 'POLICY_BEHAVIOUR_NOT_FUNCTION',
      })
    }
  })

  test('a failed import throws POLICY_BEHAVIOUR_LOAD_FAILED and is retried next time', async () => {
    let attempts = 0
    const loader = createBehaviourLoader({
      importModule: async () => {
        attempts++
        if (attempts === 1) throw new Error('ENOENT')
        return { f: () => 'ok' }
      },
    })
    const ref = moduleRef<() => string>('m', 'f')
    await assert.rejects(
      callBehaviour(loader, ref),
      (err: unknown) =>
        err instanceof PolicyError &&
        err.code === 'POLICY_BEHAVIOUR_LOAD_FAILED' &&
        err.cause instanceof Error,
    )
    assert.equal(await callBehaviour(loader, ref), 'ok')
  })

  test('a relative ref or a null behaviour fails with a PolicyError, not a stray TypeError', async () => {
    const loader = createBehaviourLoader({ importModule: async () => ({ f: () => 1 }) })
    await assert.rejects(callBehaviour(loader, moduleRef<() => number>('./x.ts', 'f')), {
      code: 'POLICY_BEHAVIOUR_LOAD_FAILED',
    })
    const nothing = null as unknown as ModuleRef<() => number>
    await assert.rejects(callBehaviour(loader, nothing), { code: 'POLICY_BEHAVIOUR_NOT_FUNCTION' })
  })
})

describe('the default importer', () => {
  test("loads the neutral policy's own behaviour refs", async () => {
    const loader = createBehaviourLoader()
    assert.equal(await callBehaviour(loader, neutralPolicy.snapshot.key, 'adds', 1), 'adds 1')
    assert.deepEqual(
      await callBehaviour(loader, neutralPolicy.orchestrator.environmentConditions, {
        name: 'jsdom',
      }),
      ['browser'],
    )
  })

  test('loads a ref by absolute path and by file: URL', async () => {
    const url = import.meta.resolve('./behaviours.ts')
    const loader = createBehaviourLoader()
    const byUrl: ModuleRef<EnvironmentConditions> = moduleRef(url, 'environmentConditions')
    const byPath: ModuleRef<EnvironmentConditions> = moduleRef(
      fileURLToPath(url),
      'environmentConditions',
    )
    assert.deepEqual(await callBehaviour(loader, byUrl, { name: 'node' }), ['node'])
    assert.deepEqual(await callBehaviour(loader, byPath, { name: 'node' }), ['node'])
  })
})
