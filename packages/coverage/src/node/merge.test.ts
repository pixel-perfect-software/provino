// The coordinator's merge of V8 coverage (T8.12, T8.9): the takes of several workers add up as
// `mergeProcessCovs` adds Jest's per-file results, the wrapper a worker put before the code is
// taken back out of V8's offsets and counts nowhere but as the module's function, a file no test
// loaded is Jest's `(empty-report)` over its size in bytes, a file that ends in types has a
// statement on each of their lines (D123), and any conversion but `v8-to-istanbul` is refused. Parity with Jest's numbers is `provino`'s
// `jest-coverage-v8.test.ts`; the merge across shards and workers is the orchestrator's
// `coverage-merge.test.ts`.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import type { IstanbulFileCoverageData, SourceMapV3, V8ScriptCoverage } from '@provino/types'
import MagicString from 'magic-string'
import { loadCoverageReporting } from './index.ts'
import type { V8Coverage } from './v8.ts'

const reporting = await loadCoverageReporting()

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fileIn(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-coverage-v8-'))
  dirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, text)
  return path
}

/** A wrapper on the code's first line, as the loader's module-runner form has one (T2.9). */
const WRAPPER = "'use strict';(function (exports) {"

/**
 * `code` compiled under `path` behind `WRAPPER` and run `calls` times with call counts on, as a
 * worker does; the take holds that one script.
 */
async function take(
  path: string,
  code: string,
  map: SourceMapV3 | null,
  calls: number,
  workerId: number,
): Promise<V8Coverage> {
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    // Each worker is its own process; here a column offset of its own (an origin option, which
    // moves no offset V8 counts) keeps V8 from handing the second take the first's script.
    const run = runInThisContext(`${WRAPPER}${code}\n})`, {
      filename: path,
      columnOffset: -WRAPPER.length - workerId,
    }) as (exports: Record<string, () => unknown>) => void
    const exports: Record<string, () => unknown> = {}
    run(exports)
    for (let call = 0; call < calls; call++) exports.f?.()
    const { result } = await session.post('Profiler.takePreciseCoverage')
    await session.post('Profiler.stopPreciseCoverage')
    const url = pathToFileURL(path).href
    const scripts: V8ScriptCoverage[] = result.filter((script) => script.url === url)
    assert.equal(scripts.length, 1, 'the script was counted')
    return {
      kind: 'v8',
      workerId,
      scripts,
      modules: [{ url, wrapperLength: WRAPPER.length, transformKey: 'k', code, map }],
    }
  } finally {
    session.disconnect()
  }
}

function only(map: Awaited<ReturnType<typeof reporting.convertV8Coverage>>['map'], path: string) {
  assert.deepEqual(map.files(), [path])
  return map.fileCoverageFor(path).toJSON() as unknown as IstanbulFileCoverageData & {
    readonly all: boolean
  }
}

const SOURCE = [
  'exports.f = function f() {',
  '  return 1',
  '}',
  'exports.g = function g() {',
  '  return 2',
  '}',
  '',
].join('\n')

test('two workers’ takes add up, and the wrapper is taken out of the offsets', async () => {
  const path = await fileIn('counted.js', SOURCE)
  const first = await take(path, SOURCE, null, 2, 1)
  const second = await take(path, SOURCE, null, 3, 2)
  const aggregate = reporting.createCoverageAggregate()
  aggregate.add(first)
  aggregate.add(second)
  assert.equal(aggregate.has(path), true)
  const { map } = await reporting.convertV8Coverage(aggregate.v8, [], {
    conversion: 'v8-to-istanbul',
    hashbang: 'kept',
  })
  const data = only(map, path)
  const byName = Object.fromEntries(
    Object.entries(data.fnMap).map(([key, fn]) => [fn.name, { fn, hits: data.f[key] }]),
  )
  // `f` ran 2 + 3 times; `g` never did.
  assert.equal(byName.f?.hits, 5)
  assert.equal(byName.g?.hits, 0)
  // Where the functions are in the code itself: line 1 from column 12, line 4 from column 12.
  // Without the wrapper's length taken out, `f` would start 34 columns further on.
  assert.deepEqual(byName.f?.fn.loc.start, { line: 1, column: 12 })
  assert.deepEqual(byName.g?.fn.loc.start, { line: 4, column: 12 })
  // Every line is a statement, counted in hits summed over both workers: the module ran once in
  // each, `f`'s body 5 times, `g`'s never.
  assert.equal(Object.keys(data.statementMap).length, 6)
  assert.deepEqual(Object.values(data.s), [2, 5, 5, 2, 0, 0])
  assert.equal(data.all, false)
})

/** A CommonJS wrapper with the module's scope bindings, as the loader writes one (T2.9). */
const SCOPED = '(function (jest) { return function (exports, require, module) {'

/**
 * `code` compiled once under `path` behind `SCOPED`, as a worker compiles a module, and loaded
 * `loads` times (a fresh registry per test file): the take of one worker.
 */
async function loaded(path: string, code: string, loads: number, workerId: number) {
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
    const outer = runInThisContext(`${SCOPED}${code}\n}})`, {
      filename: path,
      columnOffset: -SCOPED.length - workerId,
    }) as (jest: unknown) => (exports: object, require: unknown, module: object) => void
    for (let load = 0; load < loads; load++) {
      const exports: Record<string, (name: string) => string> = {}
      outer(null)(exports, null, { exports })
      exports.greet?.('ada')
    }
    const { result } = await session.post('Profiler.takePreciseCoverage')
    await session.post('Profiler.stopPreciseCoverage')
    const url = pathToFileURL(path).href
    const take: V8Coverage = {
      kind: 'v8',
      workerId,
      scripts: result.filter((script) => script.url === url),
      modules: [{ url, wrapperLength: SCOPED.length, transformKey: 'k', code, map: null }],
    }
    return take
  } finally {
    session.disconnect()
  }
}

test('the vm script and the scope function around a module count nowhere, at any worker count', async () => {
  const code = [
    'function greet(name) {',
    "  if (name === '') {",
    "    return 'nobody'",
    '  }',
    "  return 'hello ' + name",
    '}',
    'exports.greet = greet',
    '',
  ].join('\n')
  const path = await fileIn('greet.js', code)
  // Three loads either way: one worker, or two.
  for (const takes of [
    [await loaded(path, code, 3, 1)],
    [await loaded(path, code, 1, 2), await loaded(path, code, 2, 3)],
  ]) {
    const aggregate = reporting.createCoverageAggregate()
    for (const one of takes) aggregate.add(one)
    const { map } = await reporting.convertV8Coverage(aggregate.v8, [], {
      conversion: 'v8-to-istanbul',
      hashbang: 'kept',
    })
    const data = only(map, path)
    // The module's function (its loads, over the whole code, as jest-runtime's `compileFunction`
    // counts it), `greet` and its `if` block: nothing per worker, nothing for the scope function.
    assert.deepEqual(data.b, { '0': [3], '1': [3], '2': [0] })
    assert.deepEqual(data.branchMap['0']?.loc, {
      start: { line: 1, column: 0 },
      end: { line: 7, column: 21 },
    })
    assert.deepEqual(Object.values(data.s), [3, 3, 0, 0, 3, 3, 3])
  }
})

test("under v8Hashbang 'removed', a module with no map is counted one hashbang early, as Jest's", async () => {
  const text = '#!/usr/bin/env node\nfunction f() {\n  return 1\n}\nexports.f = f\n'
  const path = await fileIn('bin.js', text)
  // The loader runs the hashbang as a comment of the same length.
  const code = `//${text.slice(2)}`
  const one = await loaded(path, code, 1, 1)
  for (const [hashbang, start] of [
    ['kept', { line: 2, column: 0 }],
    // Jest ran the text without `#!/usr/bin/env node` (19 characters) and reads the offsets
    // against the file as it is: `function` at offset 1 of its code is line 1, column 1.
    ['removed', { line: 1, column: 1 }],
  ] as const) {
    const aggregate = reporting.createCoverageAggregate()
    aggregate.add(one)
    const { map } = await reporting.convertV8Coverage(aggregate.v8, [], {
      conversion: 'v8-to-istanbul',
      hashbang,
    })
    const data = only(map, path)
    assert.deepEqual(data.fnMap['0']?.loc.start, start, hashbang)
  }
})

test('a file no test loaded is one (empty-report) range over its size in bytes', async () => {
  const text = "// « € » takes three bytes\nexport const euro = (n: number): string => n + ' €'\n"
  const path = await fileIn('never.ts', text)
  const empty = reporting.emptyV8Coverage(path)
  assert.deepEqual(empty.functions, [
    {
      functionName: '(empty-report)',
      isBlockCoverage: true,
      ranges: [{ startOffset: 0, endOffset: Buffer.byteLength(text), count: 0 }],
    },
  ])
  assert.ok(Buffer.byteLength(text) > text.length)
  const aggregate = reporting.createCoverageAggregate()
  const { map } = await reporting.convertV8Coverage(aggregate.v8, [empty], {
    conversion: 'v8-to-istanbul',
    hashbang: 'kept',
  })
  const data = only(map, path)
  assert.deepEqual(Object.values(data.s), [0, 0])
  assert.deepEqual(Object.values(data.f), [0])
  assert.equal(data.fnMap['0']?.name, '(empty-report)')
  assert.equal(data.all, true)
})

test('a file that ends in types has a statement on every line, as Jest’s babel original has (D123)', async () => {
  const source = [
    'export function f() {',
    '  return 1',
    '}',
    '',
    'export interface Range {',
    '  readonly low: number',
    '}',
    '',
  ].join('\n')
  const path = await fileIn('typed.ts', source)
  // What the loader ran: the types blanked in place, `export` rewritten, a line put before it.
  const magic = new MagicString(source)
  magic.overwrite(0, 'export '.length, '       ')
  const tail = source.indexOf('export interface')
  magic.overwrite(tail, source.length - 1, source.slice(tail, -1).replace(/\S/g, ' '))
  magic.prepend('exports.f = f;\n')
  const code = magic.toString()
  const generated = magic.generateMap({ source: path, hires: 'boundary' })
  const map: SourceMapV3 = {
    version: 3,
    sources: generated.sources,
    sourcesContent: [code],
    names: generated.names,
    mappings: generated.mappings,
  }
  const ran = await take(path, code, map, 1, 1)
  const aggregate = reporting.createCoverageAggregate()
  aggregate.add(ran)
  const { map: coverage } = await reporting.convertV8Coverage(aggregate.v8, [], {
    conversion: 'v8-to-istanbul',
    hashbang: 'kept',
  })
  // Seven lines, the types' included: Jest's babel-jest with `@babel/preset-typescript` hands
  // v8-to-istanbul the TypeScript text, whose lines are all statements. Not the map's
  // `sourcesContent`, which would win over it: here it is the types-blanked code.
  assert.equal(Object.keys(only(coverage, path).statementMap).length, 7)
})

test('the AST conversion is B25’s', async () => {
  await assert.rejects(
    reporting.convertV8Coverage([], [], { conversion: 'ast', hashbang: 'kept' }),
    (error: unknown) =>
      (error as { code?: unknown }).code === 'COVERAGE_NOT_IMPLEMENTED' &&
      String((error as Error).message).includes('B25'),
  )
})
