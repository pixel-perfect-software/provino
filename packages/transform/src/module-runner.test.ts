import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { TransformRecord } from '@provino/types'
import { toModuleRunner } from './module-runner.ts'
import { createPipeline } from './pipeline.ts'

const pipeline = createPipeline({
  root: '/',
  typescript: 'oxc',
  tsconfig: false,
  hoist: null,
  cache: false,
})

function strip(filename: string, source: string): TransformRecord {
  return pipeline.transform({
    filename,
    source,
    role: 'source',
    consumer: 'import',
    instrument: false,
  })
}

test('stripped TypeScript becomes module-runner form, with deps and a composed map', () => {
  const source = [
    "import type { T } from './types.js'",
    "export type { T } from './types.js'",
    "import { value } from './dep.js'",
    'export const doubled: T = value * 2',
    "export const later = () => import('./lazy.js')",
    '',
  ].join('\n')
  const output = toModuleRunner('/m.ts', strip('/m.ts', source))
  assert.match(output.code, /__vite_ssr_import__\("\.\/dep\.js"/)
  assert.match(output.code, /__vite_ssr_dynamic_import__\("\.\/lazy\.js"\)/)
  assert.doesNotMatch(output.code, /types\.js/, 'type-only imports and exports are gone')
  assert.deepEqual(output.deps, ['./dep.js'])
  assert.deepEqual(output.dynamicDeps, ['./lazy.js'])
  assert.deepEqual(output.map?.sources, ['/m.ts'], 'the map leads back to the original file')
})

test('a failure is a per-file TransformError that names the file', () => {
  const broken: TransformRecord = { ...strip('/ok.ts', 'export {}\n'), code: 'export const = 1\n' }
  assert.throws(
    () => toModuleRunner('/broken.ts', broken),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'TRANSFORM_RUNNER_FAILED')
      assert.match(String(error), /\/broken\.ts/)
      return true
    },
  )
})

test('deps are in source order, once each, and dynamicDeps too (B20 Gap 3)', () => {
  const source = [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import { a } from './a.js'",
    "import 'node:fs'",
    "export * from './z.js'",
    "export { b } from './b.js'",
    "export const later = [import('./y.js'), import('./x.js'), import('./y.js')]",
    'export const keep = [fs, path, a]',
    '',
  ].join('\n')
  const output = toModuleRunner('/m.ts', strip('/m.ts', source))
  assert.deepEqual(output.deps, ['node:fs', 'node:path', './a.js', './z.js', './b.js'])
  assert.deepEqual(output.dynamicDeps, ['./y.js', './x.js'])
})

test('the same record gives the same bytes', () => {
  const record = strip(
    '/d.ts',
    "import { a } from './a.js'\nexport default a()\nexport const b = import.meta.url\n",
  )
  const first = toModuleRunner('/d.ts', record)
  const second = toModuleRunner('/d.ts', record)
  assert.equal(first.code, second.code)
  assert.deepEqual(first.map, second.map)
})

test('unstripped TypeScript is a per-file error naming the file, not an abort (B20)', () => {
  const unstripped: TransformRecord = {
    ...strip('/ok.ts', 'export {}\n'),
    code: 'export type T = number\nexport const x: T = 1\n',
  }
  assert.throws(
    () => toModuleRunner('/ts.ts', unstripped),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'TRANSFORM_RUNNER_FAILED')
      assert.match(String(error), /\/ts\.ts/)
      return true
    },
  )
})

function runnerError(code: string): string {
  const record: TransformRecord = { ...strip('/ok.ts', 'export {}\n'), code }
  try {
    toModuleRunner('/s.ts', record)
  } catch (error) {
    return String(error)
  }
  return ''
}

test('semantic errors fail the file with the parser’s text (the harness matches these)', () => {
  assert.match(runnerError('export { x }\n'), /\/s\.ts: Export 'x' is not defined/)
  assert.match(
    runnerError("import { vi } from 'm'\nconst vi = 1\n"),
    /Identifier `vi` has already been declared/,
  )
})

test('a `var` in a catch block that redeclares an import fails the file, as Node does', () => {
  // The parser lets this one form through (a catch parameter may share a `var`'s name), but the
  // `var` still declares the module-level name the import holds.
  assert.match(
    runnerError("import { x } from 'a'\ntry {} catch (x) { var x = 1 }\n"),
    /\/s\.ts: Identifier `x` has already been declared/,
  )
})

// The trivia the statement edits look through is the language's: every whitespace the parser
// skips, and a `//` comment that ends at any line terminator.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => unknown

function runnerCode(code: string): string {
  const record: TransformRecord = { ...strip('/ok.ts', 'export {}\n'), code }
  return toModuleRunner('/trivia.js', record).code
}

function parses(code: string): void {
  assert.doesNotThrow(
    () => new AsyncFunction('__vite_ssr_import__', '__vite_ssr_exports__', code),
    code,
  )
}

const DEFAULT_GETTER =
  'Object.defineProperty(__vite_ssr_exports__, "default", { enumerable: true, configurable: true, get() { return __vite_ssr_export_default__; } });\n'

test('`export default` is rewritten whatever whitespace or comment sits before `default`', () => {
  for (const between of [
    ' ',
    '  ',
    '\t',
    '\u000b',
    '\f',
    '\u00a0',
    '\ufeff',
    ' /* c */ ',
    ' // c\n',
    ' // c\r',
    ' // c\u2028',
    ' // c\u2029',
  ]) {
    const output = runnerCode(`export${between}default 1`)
    assert.equal(
      output,
      `${DEFAULT_GETTER}const __vite_ssr_export_default__ = 1`,
      JSON.stringify(between),
    )
    parses(output)
  }
})

test('a removed import keeps a `;` before a line that would continue the one before it', () => {
  const imported =
    'const __vite_ssr_import_0__ = await __vite_ssr_import__("a", { importedNames: ["default"] });\n'
  for (const between of [
    ' \n',
    ' \u2028',
    ' \u2029',
    '\u00a0\n',
    '\f\n',
    ' // c\r',
    ' // c\u2028',
    ' // c\u2029',
    ' /* c\n */ ',
  ]) {
    const output = runnerCode(`foo()\nimport x from 'a'${between}[1].map(f)`)
    assert.equal(output, `${imported}foo()\n;${between}[1].map(f)`, JSON.stringify(between))
    parses(output)
  }
})

test('a throw maps back to the original TypeScript line, and the map is composed once', () => {
  const source = [
    "import { a } from './a.js'",
    'export const n: number = 1',
    'export function boom(): never {',
    "  throw new Error('x' + a)",
    '}',
    '',
  ].join('\n')
  const output = toModuleRunner('/t.ts', strip('/t.ts', source))
  const generated = output.code.split('\n').findIndex((line) => line.includes('throw new')) + 1
  const map = output.map
  assert.ok(map !== null)
  const traced = new TraceMap(map as ConstructorParameters<typeof TraceMap>[0])
  const original = originalPositionFor(traced, { line: generated, column: 2 })
  assert.equal(original.line, 4)
  assert.equal(original.source, '/t.ts')
  assert.equal(output.map, map)
})

test('a JS-only file’s map leads to the file', () => {
  const record = strip('/plain.js', "import { a } from './a.js'\nexport const b = a\n")
  assert.equal(record.map, null)
  assert.deepEqual(toModuleRunner('/plain.js', record).map?.sources, ['/plain.js'])
})

test('no non-test file under packages/*/src names the deprecated oxc runner transform (B20 Gap 9)', () => {
  const packages = fileURLToPath(new URL('../../', import.meta.url))
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (
        /\.[cm]?ts$/.test(entry.name) &&
        !/\.test(-d)?\.ts$|\.d\.ts$|\/test-[^/]*$/.test(path) &&
        readFileSync(path, 'utf8').includes('moduleRunnerTransformSync')
      ) {
        offenders.push(path)
      }
    }
  }
  for (const pkg of readdirSync(packages, { withFileTypes: true })) {
    if (pkg.isDirectory() && existsSync(join(packages, pkg.name, 'src'))) {
      walk(join(packages, pkg.name, 'src'))
    }
  }
  assert.deepEqual(offenders, [])
})
