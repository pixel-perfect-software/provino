// T8.10 part 1: the vendored instrumenter against `babel-plugin-istanbul` 8.0.0, the plugin Jest
// 30.5.2's `babel` coverage provider runs, in-process over a table of constructs. Both instrument
// the same JavaScript with the options Jest passes (`compact: false`, `exclude: []`,
// `extension: false`); the coverage maps and the initial counters must be equal. A difference is
// not adjusted away here: it is a finding (the instrumenter's maps are what the reports are made of).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { IstanbulFileCoverageData, SourceMapV3 } from '@provino/types'
import { ownCodeIdentity } from './code-identity.ts'
import { readInitialCoverage } from './initial-coverage.ts'
import { istanbulInstrumenter } from './instrument.ts'
import { CASES } from './test-cases.ts'

const nodeRequire = createRequire(import.meta.url)

interface BabelCore {
  transformSync(
    code: string,
    options: Record<string, unknown>,
  ): { code?: string | null; map?: unknown } | null
}

function isBabelCore(value: unknown): value is BabelCore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { transformSync?: unknown }).transformSync === 'function'
  )
}

function loadBabel(): BabelCore {
  const core: unknown = nodeRequire('@babel/core')
  if (!isBabelCore(core)) throw new Error('@babel/core has no transformSync')
  return core
}
const babel = loadBabel()
const plugin: unknown = (nodeRequire('babel-plugin-istanbul') as { default?: unknown }).default

const ROOT = '/virtual/project'

/** What Jest's `_instrumentFile` gets from `babel-plugin-istanbul`: the file's coverage data. */
function babelCoverage(
  code: string,
  filename: string,
  inputSourceMap?: SourceMapV3,
): { coverage: Record<string, unknown>; code: string } {
  let coverage: Record<string, unknown> | undefined
  const result = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    sourceType: 'module',
    plugins: [
      [
        plugin,
        {
          compact: false,
          cwd: ROOT,
          exclude: [],
          extension: false,
          useInlineSourceMaps: false,
          ...(inputSourceMap === undefined ? {} : { inputSourceMap }),
          onCover: (_path: string, data: Record<string, unknown>) => {
            coverage = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
          },
        },
      ],
    ],
  })
  assert.ok(coverage !== undefined, 'babel-plugin-istanbul did not report coverage')
  return { coverage, code: result?.code ?? '' }
}

/** The data both instrumenters write, without the per-file digest and the input map. */
function essentials(data: IstanbulFileCoverageData | Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(data))
  delete copy.hash
  delete copy.inputSourceMap
  return copy
}

function ours(code: string, filename: string, inputMap: SourceMapV3 | null = null) {
  const result = istanbulInstrumenter().instrument(code, filename, inputMap)
  assert.ok(result.coverage !== undefined)
  return { ...result, coverage: result.coverage }
}

describe('the vendored instrumenter against babel-plugin-istanbul 8.0.0', () => {
  for (const { name, code } of CASES) {
    test(`${name}: the same maps and counters`, () => {
      const filename = `${ROOT}/src/case.js`
      const oracle = babelCoverage(code, filename)
      const mine = ours(code, filename)
      assert.deepEqual(essentials(mine.coverage), essentials(oracle.coverage))
    })
  }

  test('with an input map: the same maps, the map embedded as babel-plugin-istanbul does', () => {
    // A map that moves every line of the instrumented input down 10 lines of an imaginary source.
    const lines = 6
    const mappings = ';'.repeat(10) + Array.from({ length: lines }, () => 'AAAA').join(';')
    const inputMap: SourceMapV3 = {
      version: 3,
      sources: ['case.ts'],
      names: [],
      mappings,
    }
    const code = `export function f(a) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n`
    const filename = `${ROOT}/src/case.ts`
    const oracle = babelCoverage(code, filename, inputMap)
    const mine = ours(code, filename, inputMap)
    assert.deepEqual(essentials(mine.coverage), essentials(oracle.coverage))
    assert.deepEqual(mine.coverage.inputSourceMap, oracle.coverage.inputSourceMap)
    assert.deepEqual(mine.coverage.inputSourceMap, inputMap)
  })

  test('the written code runs and counts what it ran', () => {
    const code = `export function f(a) {\n  if (a) { return 1; }\n  return 2;\n}\n`
    const { code: instrumented, coverage } = ours(code, `${ROOT}/src/run.js`)
    // Run it as a script body: the counters are on the global the code names.
    const global: Record<string, unknown> = {}
    const body = instrumented.replace('export function f', 'function f') + '\nreturn f;'
    const f = new Function(body).call(global) as (a: unknown) => number
    assert.equal(f(1), 1)
    const data = Object.values(
      (globalThis as unknown as Record<string, Record<string, { s: Record<string, number> }>>)
        .__coverage__ ?? {},
    )
    const mineCounts = data.find((entry) => (entry as { path?: string }).path === coverage.path)
    assert.ok(mineCounts !== undefined)
    assert.equal(Object.values(mineCounts.s).filter((n) => n > 0).length > 0, true)
    delete (globalThis as unknown as Record<string, unknown>).__coverage__
  })

  test('the map leads the instrumented code back to the code it was given', () => {
    const code = `export function f(a) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n`
    const { code: instrumented, map } = ours(code, `${ROOT}/src/map.js`)
    assert.ok(map !== null)
    const trace = new TraceMap(map as unknown as ConstructorParameters<typeof TraceMap>[0])
    const lines = instrumented.split('\n')
    // `return 2;` sits on line 5 of the input: the same token, found in the output, maps to it.
    const outputLine = lines.findIndex((line) => line.includes('return 2;')) + 1
    const column = (lines[outputLine - 1] ?? '').indexOf('return 2;')
    const original = originalPositionFor(trace, { line: outputLine, column })
    assert.equal(original.line, 5)
    assert.equal(original.column, 2)
  })

  test('code the instrumenter cannot parse is a COVERAGE_INSTRUMENT_FAILED error naming the file', () => {
    assert.throws(
      () => ours('export const = ;', `${ROOT}/src/bad.js`),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === 'COVERAGE_INSTRUMENT_FAILED' &&
        error.message.includes('bad.js'),
    )
  })

  test('a file marked istanbul ignore file comes back unchanged, with no counters', () => {
    const code = `/* istanbul ignore file */\nexport const x = 1;\n`
    const result = ours(code, `${ROOT}/src/ignored.js`)
    assert.equal(result.code, code)
    assert.deepEqual(result.coverage.statementMap, {})
  })

  test('its name says which instrumenter and which variable, for the cache key', () => {
    assert.notEqual(
      istanbulInstrumenter().name,
      istanbulInstrumenter({ coverageVariable: '__other__' }).name,
    )
    assert.match(istanbulInstrumenter().name, /istanbul-lib-instrument@2\.1\.0/)
    assert.ok(istanbulInstrumenter().name.includes(ownCodeIdentity()), 'the package code is in it')
  })

  test('readInitialCoverage finds what instrumenting recorded', () => {
    const code = `export function f(a) {\n  return a ? 1 : 2;\n}\n`
    const result = ours(code, `${ROOT}/src/read.js`)
    const found = readInitialCoverage(result.code)
    assert.ok(found !== null)
    assert.equal(found.path, `${ROOT}/src/read.js`)
    assert.deepEqual(essentials(found.coverageData), essentials(result.coverage))
  })

  test('code babel-plugin-istanbul already instrumented gives its coverage back, unchanged', () => {
    const code = `export function f(a) {\n  return a ? 1 : 2;\n}\n`
    const filename = `${ROOT}/src/twice.js`
    const theirs = babelCoverage(code, filename)
    const result = istanbulInstrumenter().instrument(theirs.code, filename, null)
    assert.equal(result.code, theirs.code)
    assert.ok(result.coverage !== undefined)
    assert.deepEqual(essentials(result.coverage), essentials(theirs.coverage))
  })
})
