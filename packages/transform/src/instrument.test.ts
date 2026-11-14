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

test('D116: the instrumenter gets the TypeScript stripped in place, with no input map', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const file = join(root, 'a.ts')
  const record = createPipeline(options(root, { instrumenter })).transform(
    request(file, SOURCE, true),
  )
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call?.filename, file)
  // Every token of the JavaScript is where it is in the source: no map is needed.
  assert.equal(call?.code, 'export function f(x        )         { return x + 1 }\n')
  assert.equal(call?.inputMap, null)
  assert.match(record.code, /cov_1\(\)\.f\[0\]\+\+/)
  assert.equal(record.diagnostics.length, 0)
})

test('a file the strip cannot take (an enum) gets Oxc’s output and the map back to the TypeScript', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const file = join(root, 'a.ts')
  createPipeline(options(root, { instrumenter })).transform(
    request(file, `enum E { A }\n${SOURCE}`, true),
  )
  const [call] = calls
  assert.doesNotMatch(call?.code ?? '', /: number/, 'types are stripped before instrumenting')
  assert.match(call?.code ?? '', /E\[E\["A"\] = 0\]/, "Oxc's enum")
  assert.ok(call?.inputMap !== null && call?.inputMap !== undefined)
  assert.ok(call.inputMap.sources.some((source) => source?.endsWith('a.ts') === true))
})

test('a .tsx file, and every file under `define`, keep Oxc’s transform when instrumented', () => {
  const root = makeRoot()
  for (const [name, extra] of [
    ['a.tsx', {}],
    ['b.ts', { define: { 'process.env.X': '"x"' } }],
  ] as const) {
    const { instrumenter, calls } = standIn()
    createPipeline(options(root, { instrumenter, ...extra })).transform(
      request(join(root, name), SOURCE, true),
    )
    assert.ok(calls[0]?.inputMap !== null && calls[0]?.inputMap !== undefined, name)
  }
})

test('without `instrument`, a TypeScript file takes Oxc’s transform under `typescript: oxc`', () => {
  const root = makeRoot()
  const record = createPipeline(options(root)).transform(request(join(root, 'a.ts'), SOURCE, false))
  assert.equal(record.code, 'export function f(x) {\n\treturn x + 1;\n}\n')
  assert.ok(record.map !== null)
})

test('the import facts read from the strip’s parse equal those of a separate parse', () => {
  const root = makeRoot()
  const { instrumenter } = standIn()
  const pipeline = createPipeline(options(root, { instrumenter }))
  const source =
    "import type { T } from './t'\nimport { a } from './a'\nexport { b } from './b'\nexport const c: T = a\nexport const d = async () => import('./d')\nawait d()\n"
  const blank = pipeline.transform(request(join(root, 'a.ts'), source, true))
  const oxc = pipeline.transform(request(join(root, 'a.ts'), source, false))
  assert.ok(blank.imports.length === 3)
  assert.deepEqual(blank.imports, oxc.imports)
  assert.equal(blank.format, oxc.format)
  assert.equal(blank.hasTopLevelAwait, true)
})

test("under `typescript: 'blank'` every erasable TypeScript file is stripped in place", () => {
  const root = makeRoot()
  const record = createPipeline(options(root, { typescript: 'blank' })).transform(
    request(join(root, 'a.ts'), SOURCE, false),
  )
  assert.equal(record.code, 'export function f(x        )         { return x + 1 }\n')
  assert.equal(record.map, null)
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
    transformAsync: () =>
      Promise.resolve({
        code: '"use strict";\nexports.f = function f() { return 1; };\n',
        map,
        transformerCacheKey: 'key',
        canInstrument,
      } satisfies HostedSource),
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

test('`instrument` on a transformer file with no instrumenter is TRANSFORM_OPTION_UNSUPPORTED, not a record', async () => {
  const root = makeRoot()
  const file = join(root, 'a.ts')
  const pipeline = createPipeline(options(root, { transformers: host(false, null) }))
  assert.throws(() => pipeline.transform(request(file, SOURCE, true)), {
    code: 'TRANSFORM_OPTION_UNSUPPORTED',
  })
  await assert.rejects(pipeline.transformAsync(request(file, SOURCE, true)), {
    code: 'TRANSFORM_OPTION_UNSUPPORTED',
  })
})

test('a transformer that can instrument needs no instrumenter', async () => {
  const root = makeRoot()
  const file = join(root, 'a.ts')
  const pipeline = createPipeline(options(root, { transformers: host(true, null) }))
  assert.deepEqual(pipeline.transform(request(file, SOURCE, true)).diagnostics, [])
  assert.deepEqual((await pipeline.transformAsync(request(file, SOURCE, true))).diagnostics, [])
})

/** An instrumenter that cannot read what it is given. */
function failing(): CoverageInstrumenter {
  return {
    name: 'failing:r1',
    instrument() {
      throw new Error('could not instrument a.js: unexpected token')
    },
  }
}

test('code the instrumenter cannot read is a COVERAGE_INSTRUMENT_FAILED diagnostic, code unchanged', () => {
  const root = makeRoot()
  const source = 'export const a = 1\n'
  const record = createPipeline(options(root, { instrumenter: failing() })).transform(
    request(join(root, 'a.js'), source, true),
  )
  assert.equal(record.code, source)
  assert.deepEqual(
    record.diagnostics.map((d) => [d.severity, d.code]),
    [['error', 'COVERAGE_INSTRUMENT_FAILED']],
  )
  assert.match(record.diagnostics[0]?.message ?? '', /unexpected token/)
})

test('on a transformer file the same failure blames the instrumenter, not the transformer', () => {
  const root = makeRoot()
  const record = createPipeline(
    options(root, { instrumenter: failing(), transformers: host(false, null) }),
  ).transform(request(join(root, 'a.ts'), SOURCE, true))
  assert.deepEqual(
    record.diagnostics.map((d) => d.code),
    ['COVERAGE_INSTRUMENT_FAILED'],
  )
})

test('a file with a TypeScript parse error is not instrumented', () => {
  const root = makeRoot()
  const { instrumenter, calls } = standIn()
  const record = createPipeline(options(root, { instrumenter })).transform(
    request(join(root, 'a.ts'), 'export const = ;\n', true),
  )
  assert.equal(calls.length, 0)
  assert.ok(record.diagnostics.some((d) => d.severity === 'error'))
  assert.ok(record.diagnostics.every((d) => d.code !== 'COVERAGE_INSTRUMENT_FAILED'))
})
