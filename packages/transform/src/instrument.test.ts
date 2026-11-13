// U6: where the coverage instrumenter runs in the pipeline. After TypeScript is stripped (or after a
// project's transformer, unless it can instrument), before the hoister and the module-runner
// rewrite, with the map the earlier steps composed; its identity and the request's `instrument`
// flag are part of the cache key. The real Istanbul instrumenter, the Jest hoist policy and the
// lines of the reports are `provino`'s `instrument-pipeline.test.ts`; here a stand-in records
// what it is given.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { CoverageInstrumenter, SourceMapV3, TransformRequest } from '@provino/types'
import { blockPolicy } from './hoist/test-policies.ts'
import type { HostedSource, JestHost } from './jest-host/index.ts'
import { createPipeline, type PipelineOptions } from './pipeline.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-instrument-')))
  roots.push(root)
  return root
}

function request(filename: string, source: string, instrument: boolean): TransformRequest {
  return { filename, source, role: 'source', consumer: 'import', instrument }
}

function options(root: string, extra: Partial<PipelineOptions> = {}): PipelineOptions {
  return { root, typescript: 'oxc', tsconfig: false, hoist: null, cache: false, ...extra }
}

interface Call {
  readonly code: string
  readonly filename: string
  readonly inputMap: SourceMapV3 | null
}

/** An instrumenter that marks each function body, and records what it was given. */
function standIn(name = 'stand-in:r1') {
  const calls: Call[] = []
  const instrumenter: CoverageInstrumenter = {
    name,
    instrument(code, filename, inputMap) {
      calls.push({ code, filename, inputMap })
      return { code: code.replace(/\{\s*return/g, '{ cov_1().f[0]++; return'), map: null }
    },
  }
  return { instrumenter, calls }
}

const SOURCE = 'export function f(x: number): number { return x + 1 }\n'

test('the instrumenter gets stripped JavaScript and the map back to the TypeScript', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const file = join(root, 'a.ts')
  const record = createPipeline(options(root, { instrumenter })).transform(
    request(file, SOURCE, true),
  )
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call?.filename, file)
  assert.doesNotMatch(call?.code ?? '', /: number/, 'types are stripped before instrumenting')
  assert.ok(call?.inputMap !== null && call?.inputMap !== undefined)
  assert.ok(call.inputMap.sources.some((source) => source?.endsWith('a.ts') === true))
  assert.match(record.code, /cov_1\(\)\.f\[0\]\+\+/)
  assert.equal(record.diagnostics.length, 0)
})

test('a JavaScript file with no earlier step is instrumented with no input map', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const record = createPipeline(options(root, { instrumenter })).transform(
    request(join(root, 'a.js'), 'export function f() { return 1 }\n', true),
  )
  assert.equal(calls[0]?.inputMap, null)
  assert.match(record.code, /cov_1/)
})

test('a request without `instrument` does not run it', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const record = createPipeline(options(root, { instrumenter })).transform(
    request(join(root, 'a.ts'), SOURCE, false),
  )
  assert.equal(calls.length, 0)
  assert.doesNotMatch(record.code, /cov_1/)
})

test('`instrument` without an instrumenter is TRANSFORM_OPTION_UNSUPPORTED', () => {
  const root = makeRoot()
  assert.throws(
    () => createPipeline(options(root)).transform(request(join(root, 'a.ts'), SOURCE, true)),
    { code: 'TRANSFORM_OPTION_UNSUPPORTED' },
  )
})

test('`instrument` is in the cache key, and so is the instrumenter', () => {
  const root = makeRoot()
  const file = join(root, 'a.ts')
  const one = createPipeline(options(root, { instrumenter: standIn('x:r1').instrumenter }))
  const two = createPipeline(options(root, { instrumenter: standIn('x:r2').instrumenter }))
  assert.notEqual(one.fingerprint, two.fingerprint)
  const plain = one.transform(request(file, SOURCE, false))
  const counted = one.transform(request(file, SOURCE, true))
  assert.notEqual(plain.cacheKey, counted.cacheKey)
  assert.notEqual(counted.cacheKey, two.transform(request(file, SOURCE, true)).cacheKey)
})

test('an instrumented record and a plain one live side by side in the cache', () => {
  const root = makeRoot()
  const { instrumenter } = standIn()
  const dir = join(root, 'cache')
  const make = () => createPipeline(options(root, { instrumenter, cache: { dir } }))
  const file = join(root, 'a.ts')
  const counted = make().transform(request(file, SOURCE, true))
  const plain = make().transform(request(file, SOURCE, false))
  assert.equal(counted.fromCache, false)
  assert.equal(plain.fromCache, false, 'the plain entry is not the instrumented one')
  const again = make().transform(request(file, SOURCE, true))
  assert.equal(again.fromCache, true)
  assert.equal(again.code, counted.code)
  assert.doesNotMatch(plain.code, /cov_1/)
})

test('it runs before the hoister: a factory that reads cov_* is allowed and the call still hoists', () => {
  const root = makeRoot()
  const instrumenter: CoverageInstrumenter = {
    name: 'factory:r1',
    instrument: (code) => ({
      code: code.replace('() => ({ a: 1 })', '() => { cov_9().f[0]++; return { a: 1 } }'),
      map: null,
    }),
  }
  const source = "import { x } from './x'\njest.mock('./m', () => ({ a: 1 }))\nexport const y = x\n"
  const record = createPipeline(options(root, { instrumenter, hoist: blockPolicy })).transform(
    request(join(root, 'a.test.js'), source, true),
  )
  assert.deepEqual(
    record.diagnostics.filter((d) => d.severity === 'error'),
    [],
  )
  assert.match(record.code, /cov_9\(\)\.f\[0\]\+\+/)
  assert.ok(record.code.indexOf("jest.mock('./m'") < record.code.indexOf('__provino_import'))
  assert.equal(record.staticMocks.length, 1)
})

/** A transformer host whose output is fixed, with `canInstrument` as given. */
function host(canInstrument: boolean, map: SourceMapV3 | null) {
  const stub: JestHost = {
    handles: (filename) => filename.endsWith('.ts'),
    cacheKey: () => 'key',
    cacheKeyAsync: () => Promise.resolve('key'),
    transform: (): HostedSource => ({
      code: '"use strict";\nexports.f = function f() { return 1; };\n',
      map,
      transformerCacheKey: 'key',
      canInstrument,
    }),
    transformAsync: () => Promise.reject(new Error('sync only')),
    fingerprint: `fp-${canInstrument}`,
    hoistedMarkers: [],
  }
  return stub
}

test('a project transformer is instrumented after it ran, with its own map', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const hostMap: SourceMapV3 = { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' }
  const record = createPipeline(
    options(root, { instrumenter, transformers: host(false, hostMap) }),
  ).transform(request(join(root, 'a.ts'), SOURCE, true))
  assert.equal(calls.length, 1)
  assert.match(calls[0]?.code ?? '', /exports\.f = function f\(\)/)
  assert.deepEqual(calls[0]?.inputMap, hostMap)
  assert.match(record.code, /cov_1/)
})

test('a transformer that can instrument does it itself: the instrumenter does not run', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const record = createPipeline(
    options(root, { instrumenter, transformers: host(true, null) }),
  ).transform(request(join(root, 'a.ts'), SOURCE, true))
  assert.equal(calls.length, 0)
  assert.doesNotMatch(record.code, /cov_1/)
})

test('a transformer file with no `instrument` request is not instrumented either', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  createPipeline(options(root, { instrumenter, transformers: host(false, null) })).transform(
    request(join(root, 'a.ts'), SOURCE, false),
  )
  assert.equal(calls.length, 0)
})
