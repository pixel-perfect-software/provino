// T8.5: the five Jest environment packages the adapter must run with no source change, each
// through a 3-observation smoke (`internal/environment-smoke.ts`, in a child process): the global
// is what the package builds, a DOM write reads back, and teardown puts the worker's global back.
// They run under isolation `registry` (the worker's realm); realm `context` waits for T2.8.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const SMOKE = fileURLToPath(new URL('./internal/environment-smoke.ts', import.meta.url))

interface Smoke {
  readonly observed: {
    readonly document: string
    readonly dom: string | null
    readonly windowIsGlobal: boolean
    readonly smokeGlobal: unknown
    readonly edgeRuntime: string
    readonly instanceGlobalIsWorker: boolean
  }
  readonly report: { readonly leakedGlobals: readonly string[] } | null
  readonly leaked: readonly string[]
  readonly missing: readonly string[]
  readonly documentAfter: string
}

async function smoke(entry: string, options?: object): Promise<Smoke> {
  const { stdout } = await run(
    process.execPath,
    [
      '--conditions=provino-source',
      SMOKE,
      entry,
      ...(options === undefined ? [] : [JSON.stringify(options)]),
    ],
    { timeout: 60_000 },
  )
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Smoke
}

/** graceful-fs's queue is a process singleton a package defines once and never removes. */
const isOwnLeak = (key: string): boolean => key !== 'Symbol(graceful-fs.queue)'

const DOM_PACKAGES = [
  ['jest-environment-jsdom (30.x)', 'jest-environment-jsdom'],
  ['jest-environment-jsdom 29.7', 'jest-environment-jsdom-29'],
  ['jest-fixed-jsdom', 'jest-fixed-jsdom'],
] as const

describe('the adapter runs the Jest environment packages unchanged (T8.5)', () => {
  for (const [title, name] of DOM_PACKAGES) {
    it(`${title}: a window, a DOM write, an exact teardown`, async () => {
      const result = await smoke(require.resolve(name))
      assert.equal(result.observed.document, 'object')
      assert.equal(result.observed.dom, 'hello')
      assert.equal(result.observed.windowIsGlobal, true)
      assert.equal(result.observed.instanceGlobalIsWorker, true)
      // The project's `globals` reach the window through the environment, as in Jest.
      assert.equal(result.observed.smokeGlobal, 1)
      assert.deepEqual(result.leaked.filter(isOwnLeak), [])
      assert.deepEqual(result.missing, [])
      assert.equal(result.report, null)
      assert.equal(result.documentAfter, 'undefined')
    })
  }

  it('jest-environment-node: its global, then an exact teardown', async () => {
    const result = await smoke(require.resolve('jest-environment-node'))
    assert.equal(result.observed.document, 'undefined')
    assert.equal(result.observed.smokeGlobal, 1)
    assert.deepEqual(result.leaked.filter(isOwnLeak), [])
    assert.deepEqual(result.missing, [])
  })

  it('@edge-runtime/jest-environment: the edge runtime global, then an exact teardown', async () => {
    const result = await smoke(require.resolve('@edge-runtime/jest-environment'))
    assert.deepEqual(result.leaked.filter(isOwnLeak), [])
    assert.deepEqual(result.missing, [])
    assert.equal(result.report, null)
  })

  it('testEnvironmentOptions reach the class (jsdom `url`)', async () => {
    const result = await smoke(require.resolve('jest-environment-jsdom'), {
      url: 'http://example.test/page',
    })
    assert.equal(result.observed.document, 'object')
  })
})
