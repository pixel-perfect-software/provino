// T3.6 through the pipeline: a second pipeline over the same directory is served from it, with
// everything the loader reads, and a change to any input of the key is a miss.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { TransformRequest } from '@provino/types'
import { blockPolicy, topLevelPolicy } from '../hoist/test-policies.ts'
import type { HostedSource, JestHost } from '../jest-host/index.ts'
import { toModuleRunner } from '../module-runner.ts'
import { createPipeline, type PipelineOptions } from '../pipeline.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-pipeline-cache-'))
  dirs.push(dir)
  return dir
}

function request(filename: string, source: string, extra: Partial<TransformRequest> = {}) {
  return {
    filename,
    source,
    role: 'test',
    consumer: 'import',
    instrument: false,
    ...extra,
  } as const satisfies TransformRequest
}

interface Setup {
  readonly root: string
  readonly cacheDir: string
  make(extra?: Partial<PipelineOptions>): ReturnType<typeof createPipeline>
}

function setup(): Setup {
  const root = tempDir()
  const cacheDir = join(tempDir(), 't')
  return {
    root,
    cacheDir,
    make: (extra = {}) =>
      createPipeline({
        root,
        typescript: 'oxc',
        tsconfig: 'auto',
        hoist: blockPolicy,
        cache: { dir: cacheDir },
        ...extra,
      }),
  }
}

const TEST_SOURCE = `import { a } from './a'
jest.mock('./b', () => ({ b: 1 }))
jest.mock('./c')
export const x: number = a
`

test('a second pipeline is served from the cache with everything the loader reads', () => {
  const { root, make } = setup()
  const file = join(root, 'a.test.ts')
  const cold = make().transform(request(file, TEST_SOURCE))
  assert.equal(cold.fromCache, false)
  assert.deepEqual(
    cold.staticMocks.map((mock) => mock.specifier),
    ['./b', './c'],
  )
  assert.ok(cold.lateDeps.length > 0, 'the import rewrite made late dependencies')

  const warm = make().transform(request(file, TEST_SOURCE))
  assert.equal(warm.fromCache, true)
  assert.deepEqual({ ...warm, fromCache: false }, cold)
})

test('with the cache off nothing is written', () => {
  const { root, cacheDir, make } = setup()
  make({ cache: false }).transform(request(join(root, 'a.ts'), 'export const a = 1\n'))
  assert.equal(existsSync(cacheDir), false)
})

test('the cache directory is tagged, and an entry is where its key says', () => {
  const { root, cacheDir, make } = setup()
  const record = make().transform(request(join(root, 'a.ts'), 'export const a: number = 1\n'))
  assert.ok(existsSync(join(cacheDir, 'CACHEDIR.TAG')))
  assert.ok(readdirSync(join(cacheDir, record.cacheKey.slice(0, 2))).includes(record.cacheKey))
})

test('changing the content, the path or the role misses', () => {
  const { root, make } = setup()
  const file = join(root, 'a.ts')
  const pipeline = make()
  pipeline.transform(request(file, 'export const a = 1\n'))
  assert.equal(make().transform(request(file, 'export const a = 1\n')).fromCache, true)
  assert.equal(make().transform(request(file, 'export const a = 2\n')).fromCache, false)
  assert.equal(
    make().transform(request(join(root, 'b.ts'), 'export const a = 1\n')).fromCache,
    false,
  )
  assert.equal(
    make().transform(request(file, 'export const a = 1\n', { role: 'dependency' })).fromCache,
    false,
  )
})

test("changing the tsconfig's jsx misses", () => {
  const { root, make } = setup()
  const file = join(root, 'view.tsx')
  const source = 'export const v = <div />\n'
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"jsx":"react-jsx"}}')
  assert.equal(make().transform(request(file, source)).fromCache, false)
  assert.equal(make().transform(request(file, source)).fromCache, true)
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"jsx":"react"}}')
  const classic = make().transform(request(file, source))
  assert.equal(classic.fromCache, false)
  assert.match(classic.code, /React\.createElement/)
})

test('changing the hoist policy misses', () => {
  const { root, make } = setup()
  const file = join(root, 'a.test.ts')
  assert.equal(make().transform(request(file, TEST_SOURCE)).fromCache, false)
  assert.equal(make().transform(request(file, TEST_SOURCE)).fromCache, true)
  assert.equal(
    make({ hoist: topLevelPolicy }).transform(request(file, TEST_SOURCE)).fromCache,
    false,
  )
  assert.equal(make({ hoist: null }).transform(request(file, TEST_SOURCE)).fromCache, false)
})

test('a file with a syntax error is not cached', () => {
  const { root, cacheDir, make } = setup()
  const file = join(root, 'bad.ts')
  const record = make().transform(request(file, 'export const = \n'))
  assert.ok(record.diagnostics.length > 0)
  assert.equal(make().transform(request(file, 'export const = \n')).fromCache, false)
  assert.equal(existsSync(join(cacheDir, record.cacheKey.slice(0, 2), record.cacheKey)), false)
})

interface StubOptions {
  readonly transformerKey: string | null
  readonly fingerprint?: string
}

/** A transformer host that counts what it is asked to process. */
function stubHost(options: StubOptions) {
  const calls = { cacheKey: 0, process: 0 }
  const host: JestHost = {
    handles: (filename) => filename.endsWith('.ts'),
    cacheKey() {
      calls.cacheKey++
      return options.transformerKey
    },
    cacheKeyAsync() {
      calls.cacheKey++
      return Promise.resolve(options.transformerKey)
    },
    transform(req, known) {
      calls.process++
      if (known !== undefined) assert.equal(known, options.transformerKey)
      return hosted(req)
    },
    transformAsync(req) {
      calls.process++
      return Promise.resolve(hosted(req))
    },
    fingerprint: options.fingerprint ?? 'fp',
    hoistedMarkers: [],
  }
  function hosted(req: TransformRequest): HostedSource {
    return {
      code: `"use strict";\njest.mock('./m');\nconst x = require('./m');\nexports.n = ${JSON.stringify(req.source.length)};\n`,
      map: null,
      transformerCacheKey: options.transformerKey,
      canInstrument: false,
    }
  }
  return { host, calls }
}

test('a hosted file is served from the cache, and getCacheKey runs once per file', () => {
  const { root, make } = setup()
  const file = join(root, 'a.ts')
  const first = stubHost({ transformerKey: 'k1' })
  const cold = make({ transformers: first.host }).transform(request(file, 'export const a = 1\n'))
  assert.deepEqual(first.calls, { cacheKey: 1, process: 1 })
  assert.equal(cold.fromCache, false)
  assert.deepEqual(
    cold.staticMocks.map((mock) => mock.specifier),
    ['./m'],
  )

  const second = stubHost({ transformerKey: 'k1' })
  const warm = make({ transformers: second.host }).transform(request(file, 'export const a = 1\n'))
  assert.deepEqual(second.calls, { cacheKey: 1, process: 0 })
  assert.equal(warm.fromCache, true)
  assert.deepEqual({ ...warm, fromCache: false }, cold)
})

test("changing a transformer's own cache key or its options misses", () => {
  const { root, make } = setup()
  const file = join(root, 'a.ts')
  const source = 'export const a = 1\n'
  const run = (options: StubOptions) => {
    const stub = stubHost(options)
    return make({ transformers: stub.host }).transform(request(file, source)).fromCache
  }
  assert.equal(run({ transformerKey: 'k1' }), false)
  assert.equal(run({ transformerKey: 'k1' }), true)
  assert.equal(run({ transformerKey: 'k2' }), false, "the transformer's cache key")
  assert.equal(run({ transformerKey: 'k1', fingerprint: 'other options' }), false, 'its options')
  assert.equal(run({ transformerKey: null }), false, 'no key: the content is the key')
  assert.equal(run({ transformerKey: null }), true)
})

test('transformAsync reads through the cache as transform does', async () => {
  const { root, make } = setup()
  const file = join(root, 'a.ts')
  const cold = await make().transformAsync(request(file, 'export const a = 1\n'))
  assert.equal(cold.fromCache, false)
  const sync = make().transform(request(file, 'export const a = 1\n'))
  assert.equal(sync.fromCache, true)
  const stub = stubHost({ transformerKey: 'k' })
  const hosted = make({ transformers: stub.host })
  assert.equal((await hosted.transformAsync(request(file, 'export {}\n'))).fromCache, false)
  assert.equal((await hosted.transformAsync(request(file, 'export {}\n'))).fromCache, true)
  assert.equal(stub.calls.process, 1)
  mkdirSync(join(root, 'unused'), { recursive: true })
})

const RUNNER_SOURCE = `import { a } from './a'
export const x: number = a
`

test('with runnerForm, a warm hit carries the module-runner form and skips the step (B20 Q3)', () => {
  const { root, make } = setup()
  const file = join(root, 'a.test.ts')
  const cold = make({ runnerForm: true }).transform(request(file, RUNNER_SOURCE))
  assert.equal(cold.fromCache, false)
  assert.ok(cold.runner !== undefined, 'a cold record has the form')
  assert.deepEqual(cold.runner.deps, ['./a'])

  const warm = make({ runnerForm: true }).transform(request(file, RUNNER_SOURCE))
  assert.equal(warm.fromCache, true)
  assert.equal(warm.runner?.code, cold.runner.code)
  assert.deepEqual(warm.runner?.deps, cold.runner.deps)
  assert.deepEqual(warm.runner?.edits, cold.runner.edits)

  // The step is skipped, not repeated: a record whose own code the step would reject still gives
  // the cached form.
  const output = toModuleRunner(file, warm)
  assert.equal(output.code, cold.runner.code)
  const poisoned = toModuleRunner(file, { ...warm, code: 'export const = (' })
  assert.equal(poisoned.code, cold.runner.code, 'no parse of the record’s code')
  assert.deepEqual(toModuleRunner(file, cold).deps, output.deps)
  assert.deepEqual(output.map?.sources, [file])
})

test('the runner form is its own fingerprint input: without it, entries are separate', () => {
  const { root, make } = setup()
  const file = join(root, 'a.test.ts')
  const plain = make().transform(request(file, RUNNER_SOURCE))
  assert.equal(plain.runner, undefined)
  const withForm = make({ runnerForm: true }).transform(request(file, RUNNER_SOURCE))
  assert.equal(withForm.fromCache, false, 'a plain entry is not served to a runnerForm pipeline')
  assert.ok(withForm.runner !== undefined)
  assert.equal(make().transform(request(file, RUNNER_SOURCE)).runner, undefined)
  assert.notEqual(make().fingerprint, make({ runnerForm: true }).fingerprint)
})

test('a file the step rejects keeps no runner form and fails when the loader runs the step', () => {
  const { root, make } = setup()
  const file = join(root, 'dup.ts')
  const record = make({ runnerForm: true }).transform(
    request(file, 'export default 1\nexport default 2\n'),
  )
  assert.equal(record.runner, undefined)
  assert.throws(() => toModuleRunner(file, record), /multiple default exports/)
})

test('a CommonJS file has no runner form', () => {
  const { root, make } = setup()
  const record = make({ runnerForm: true }).transform(
    request(join(root, 'c.js'), 'module.exports = { a: 1 }\n'),
  )
  assert.equal(record.format, 'cjs')
  assert.equal(record.runner, undefined)
})
