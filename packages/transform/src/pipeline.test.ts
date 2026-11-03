import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { HoistPolicy, TransformRequest } from '@provino/types'
import { composeMaps } from './internal/maps.ts'
import { createPipeline, type PipelineOptions } from './pipeline.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-transform-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function options(root: string, extra: Partial<PipelineOptions> = {}): PipelineOptions {
  return { root, typescript: 'oxc', tsconfig: 'auto', hoist: null, cache: false, ...extra }
}

function request(filename: string, source: string, extra: Partial<TransformRequest> = {}) {
  return {
    filename,
    source,
    role: 'source',
    consumer: 'import',
    instrument: false,
    ...extra,
  } as const
}

const HOIST: HoistPolicy = {
  id: 'test-hoist',
  objects: [{ kind: 'global', name: 'jest' }],
  hoistCalls: { mock: 'path-factory-options' },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: true,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: {
    allowGlobals: new Set(['Math']),
    allowPattern: /^mock/i,
    hoistPureConsts: true,
  },
  runnerModules: ['@jest/globals'],
}

test('a thrown stack maps to the original .ts line and column', async () => {
  const root = writeTree({})
  const tsFile = join(root, 'boom.ts')
  const source = [
    'interface Shape {',
    '  readonly sides: number',
    '}',
    'const square: Shape = { sides: 4 }',
    'export function boom(): never {',
    "  throw new Error('sides ' + String(square.sides as number))",
    '}',
    '',
  ].join('\n')
  const record = createPipeline(options(root)).transform(request(tsFile, source))
  assert.notEqual(record.map, null)
  const inline = Buffer.from(JSON.stringify(record.map)).toString('base64')
  const jsFile = join(root, 'boom.mjs')
  writeFileSync(
    jsFile,
    `${record.code}\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
  )

  process.setSourceMapsEnabled(true)
  const loaded: { boom: () => never } = await import(pathToFileURL(jsFile).href)
  const stack = (() => {
    try {
      loaded.boom()
    } catch (error) {
      return error instanceof Error ? (error.stack ?? '') : ''
    }
    return ''
  })()
  // `throw new Error` is on line 6; `new` starts at column 9.
  assert.match(stack, /boom\.ts:6:9\)/)
})

test('TypeScript is stripped, and the record lists runtime imports with their spans', () => {
  const root = writeTree({})
  const file = join(root, 'a.ts')
  const source = [
    '// é: offsets count UTF-16 code units',
    "import type { T } from './types.js'",
    "import def, { named, type Only } from './mod.js'",
    "import * as ns from './ns.js'",
    "import './side.js'",
    "export { x } from './re.js'",
    "export * from './star.js'",
    "export type { Y } from './type-only.js'",
    "const lazy = () => import('./dyn.js')",
    'const computed = (p: string) => import(p)',
    'export const value: T | Only = [def, named, ns, lazy, computed]',
    '',
  ].join('\n')
  const record = createPipeline(options(root)).transform(request(file, source))
  assert.equal(record.format, 'esm')
  assert.deepEqual(record.diagnostics, [])
  assert.doesNotMatch(record.code, /: string|type Only|interface/)
  assert.deepEqual(
    record.imports.map(({ specifier, kind, names }) => ({ specifier, kind, names })),
    [
      { specifier: './mod.js', kind: 'static', names: ['default', 'named'] },
      { specifier: './ns.js', kind: 'static', names: '*' },
      { specifier: './side.js', kind: 'static', names: [] },
      { specifier: './re.js', kind: 'reexport', names: ['x'] },
      { specifier: './star.js', kind: 'reexport', names: '*' },
      { specifier: './dyn.js', kind: 'dynamic', names: '*' },
    ],
  )
  for (const entry of record.imports) {
    assert.equal(source.slice(entry.start + 1, entry.end - 1), entry.specifier, entry.specifier)
  }
})

test('require calls are recorded in CommonJS files', () => {
  const root = writeTree({})
  const source =
    "const a = require('./a.cjs')\nconst b = require(dynamicName)\nmodule.exports = a\n"
  const record = createPipeline(options(root)).transform(request(join(root, 'x.cts'), source))
  assert.equal(record.format, 'cjs')
  assert.deepEqual(
    record.imports.map(({ specifier, kind }) => ({ specifier, kind })),
    [{ specifier: './a.cjs', kind: 'require' }],
  )
})

test('top-level await is found at the top level only', () => {
  const root = writeTree({})
  const pipeline = createPipeline(options(root))
  const facts = (source: string) =>
    pipeline.transform(request(join(root, 'tla.ts'), source)).hasTopLevelAwait
  assert.equal(facts('export const x = await Promise.resolve(1)\n'), true)
  assert.equal(facts('for await (const x of []) {}\nexport {}\n'), true)
  assert.equal(facts('if (globalThis.a) { await 1 }\nexport {}\n'), true)
  assert.equal(facts('export async function f() { await 1 }\n'), false)
  assert.equal(facts('export const f = async () => { await 1 }\n'), false)
  assert.equal(facts('export const x = 1\n'), false)
})

test('plain JavaScript passes through untouched, unless define is set', () => {
  const root = writeTree({})
  const file = join(root, 'plain.mjs')
  const source = 'export const env = process.env.NODE_ENV\n'
  const plain = createPipeline(options(root)).transform(request(file, source))
  assert.equal(plain.code, source)
  assert.equal(plain.map, null)
  assert.equal(plain.format, 'esm')
  const defined = createPipeline(
    options(root, { define: { 'process.env.NODE_ENV': '"test"' } }),
  ).transform(request(file, source))
  assert.match(defined.code, /"test"/)
  assert.notEqual(defined.map, null)
})

test('tsconfig options shape the output, through extends and JSONC', () => {
  const root = writeTree({
    'node_modules/@acme/tsconfig/base.json': JSON.stringify({
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    }),
    'node_modules/@acme/tsconfig/package.json': JSON.stringify({ name: '@acme/tsconfig' }),
    'tsconfig.base.json': `{
      // comments and trailing commas are allowed
      "extends": "@acme/tsconfig/base.json",
      "compilerOptions": { "jsx": "react", "jsxFactory": "h", /* inline */ },
    }`,
    'app/tsconfig.json': JSON.stringify({
      extends: '../tsconfig.base.json',
      compilerOptions: { verbatimModuleSyntax: true },
    }),
  })
  const pipeline = createPipeline(options(root))
  const tsx = pipeline.transform(request(join(root, 'app/view.tsx'), 'export const v = <div />\n'))
  assert.match(tsx.code, /h\("div"/, 'classic runtime with jsxFactory h')
  const decorated = pipeline.transform(
    request(
      join(root, 'app/model.ts'),
      [
        "import { unused } from './unused.js'",
        'declare const log: (target: object, key: string) => void',
        'export class Model {',
        '  @log name: string = "a"',
        '  declared: string',
        '}',
        '',
      ].join('\n'),
    ),
  )
  assert.match(decorated.code, /_decorate|__decorate/, 'legacy decorators')
  assert.match(decorated.code, /from ['"]\.\/unused\.js['"]/, 'verbatimModuleSyntax keeps imports')
  assert.doesNotMatch(decorated.code, /declared/, 'useDefineForClassFields: false drops it')

  const automatic = createPipeline(options(root, { tsconfig: false })).transform(
    request(join(root, 'app/view.tsx'), 'export const v = <div />\n'),
  )
  assert.match(automatic.code, /jsxDEV/, 'the default is the automatic dev runtime')
})

test('a syntax error is a diagnostic with a location, not a throw', () => {
  const root = writeTree({})
  const record = createPipeline(options(root)).transform(
    request(join(root, 'bad.ts'), 'const ok = 1\nconst = 2\n'),
  )
  const [first] = record.diagnostics
  assert.equal(first?.severity, 'error')
  assert.equal(first?.code, 'PARSE_ERROR')
  assert.equal(first?.loc?.line, 2)
  assert.equal(typeof first?.codeFrame, 'string')
})

test('unsupported inputs throw coded errors', () => {
  const root = writeTree({})
  const pipeline = createPipeline(options(root))
  assert.throws(() => pipeline.transform(request(join(root, 'a.css'), '')), {
    code: 'TRANSFORM_UNSUPPORTED_FILE',
  })
  assert.throws(() => pipeline.transform(request(join(root, 'a.ts'), '', { instrument: true })), {
    code: 'TRANSFORM_OPTION_UNSUPPORTED',
  })
  assert.throws(() => createPipeline(options(root, { typescript: 'node-strip' })), {
    code: 'TRANSFORM_OPTION_UNSUPPORTED',
  })
  writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": ')
  assert.throws(() => pipeline.transform(request(join(root, 'b.ts'), '')), {
    code: 'TRANSFORM_TSCONFIG_INVALID',
  })
})

test('a tsconfig base that cannot be found is a warning, and the rest still applies', () => {
  const root = writeTree({
    'tsconfig.json': JSON.stringify({
      extends: ['@missing/preset/tsconfig.json', './missing-local.json'],
      compilerOptions: { jsx: 'react', jsxFactory: 'h' },
    }),
  })
  const record = createPipeline(options(root)).transform(
    request(join(root, 'view.tsx'), 'export const v = <div />\n'),
  )
  assert.match(record.code, /h\("div"/)
  assert.deepEqual(
    record.diagnostics.map(({ severity, code }) => ({ severity, code })),
    [
      { severity: 'warning', code: 'TSCONFIG_EXTENDS_NOT_FOUND' },
      { severity: 'warning', code: 'TSCONFIG_EXTENDS_NOT_FOUND' },
    ],
  )
})

test('the hoist hook runs for test and setup files only, and is a no-op until T3.4', () => {
  const root = writeTree({})
  const source = "jest.mock('./dep.js')\nimport { dep } from './dep.js'\nexport { dep }\n"
  const pipeline = createPipeline(options(root, { hoist: HOIST }))
  const asTest = pipeline.transform(request(join(root, 'a.test.ts'), source, { role: 'test' }))
  const asSource = pipeline.transform(request(join(root, 'a.test.ts'), source))
  assert.deepEqual(asTest.staticMocks, [])
  assert.equal(asTest.code, asSource.code)
})

test('cache keys and the fingerprint change with their inputs', () => {
  const root = writeTree({})
  const a = createPipeline(options(root))
  const b = createPipeline(options(root, { hoist: HOIST }))
  assert.equal(a.fingerprint, createPipeline(options(root)).fingerprint)
  assert.notEqual(a.fingerprint, b.fingerprint)
  const key = (source: string, file = 'k.ts') =>
    a.transform(request(join(root, file), source)).cacheKey
  assert.equal(key('export {}\n'), key('export {}\n'))
  assert.notEqual(key('export {}\n'), key('export const x = 1\n'))
  assert.notEqual(key('export {}\n'), key('export {}\n', 'other.ts'))
})

test('transformAsync returns what transform does', async () => {
  const root = writeTree({})
  const pipeline = createPipeline(options(root))
  const req = request(join(root, 'async.ts'), 'export const n: number = 1\n')
  assert.deepEqual(await pipeline.transformAsync(req), pipeline.transform(req))
})

test('composed maps lead from the last step back to the original source', () => {
  const root = writeTree({})
  const original = 'const pad: string = "x"\nexport const marker = LONG_NAME\n'
  const first = createPipeline(options(root)).transform(request(join(root, 'm.ts'), original))
  const second = createPipeline(
    options(root, { define: { LONG_NAME: '"a much longer replacement value"' } }),
  ).transform(request(join(root, 'm.mjs'), first.code))
  const composed = composeMaps([first.map, second.map])
  assert.ok(composed, 'two maps compose')
  const outLine = second.code.split('\n').findIndex((line) => line.includes('marker'))
  const outColumn = second.code.split('\n')[outLine]?.indexOf('marker') ?? -1
  const payload = {
    file: composed.file ?? '',
    version: composed.version,
    sources: composed.sources.map((source) => source ?? ''),
    sourcesContent: (composed.sourcesContent ?? []).map((content) => content ?? ''),
    names: [...composed.names],
    mappings: composed.mappings,
    sourceRoot: composed.sourceRoot ?? '',
  }
  const entry = new SourceMap(payload).findEntry(outLine, outColumn)
  assert.ok('originalLine' in entry, 'the position maps somewhere')
  assert.equal(entry.originalLine, 1, 'line 2 of the original (0-based 1)')
  assert.equal(entry.originalColumn, original.split('\n')[1]?.indexOf('marker'))
  assert.equal(composeMaps([null, first.map]), first.map)
  assert.equal(composeMaps([null, null]), null)
})
