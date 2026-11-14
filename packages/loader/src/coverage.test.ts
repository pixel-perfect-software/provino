// T2.9 (B23b): V8's coverage of a loaded fixture, read back through `Loader.compiledModule`, lands
// on the lines of the source the file was written in, with zero offset errors. The fixture is run
// in a child process under a `node:inspector` session (precise coverage is process-wide, so the
// test runner's own scripts stay out of it); the child ends before the test reads its output.
//
// What an offset is: V8's `startOffset`/`endOffset` count characters of the whole script, wrapper
// included. Minus `wrapperLength` it is a position in the module's transformed code, which the
// composed map takes to the source. A range end has no map segment of its own (it is the position
// after the last token), so the map answers with the segment before it: still on the construct's
// last line, which is what the check reads. A function declaration's start is a token, so its
// column is held exact too.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { SourceMapV3 } from '@provino/types'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** The fixture project: a TypeScript ES module, CommonJS with a hashbang, and CommonJS on one line. */
const FILES: Readonly<Record<string, string>> = {
  'esm.ts': [
    "import { helper } from './oneline.cjs'",
    'export function pick(n: number): string { // @pick',
    '  if (n > 0) {',
    "    return helper('pos')",
    '  } else { // @else',
    "    return 'neg'",
    '  } // @else-end',
    '} // @pick-end',
    'export const arrow = (a: number): number => (a ? 1 : 2) // @arrow',
    'export function unused(): number { // @unused',
    '  return 42',
    '} // @unused-end',
    "export const later = async (): Promise<unknown> => import('./oneline.cjs') // @later",
    '',
  ].join('\n'),
  'oneline.cjs':
    "exports.helper = function helper(x) { if (x) { return x + '!' } else { return '' } }; exports.never = function never() { return 1 }\n",
  'shebang.cjs': [
    '#!/usr/bin/env node',
    'exports.shebang = function shebang() { // @shebang',
    '  return 1',
    '} // @shebang-end',
    'exports.shebangUnused = function shebangUnused() { return 2 } // @shebang-unused',
    '',
  ].join('\n'),
  // Top-level await: its wrapper is the async one (an `async function` where the others have spaces).
  'tla.ts': [
    'export function twice(n: number): number { // @twice',
    '  return n * 2',
    '} // @twice-end',
    'await Promise.resolve()',
    '',
  ].join('\n'),
  'entry.ts': [
    "import { pick, arrow, later } from './esm.ts'",
    "import { shebang } from './shebang.cjs'",
    "import { twice } from './tla.ts'",
    'export const out: unknown[] = [pick(1), arrow(1), shebang(), twice(2)]',
    'export const loaded = await later()',
    '',
  ].join('\n'),
}

function writeTree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-coverage-loader-')))
  roots.push(root)
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

interface V8Range {
  startOffset: number
  endOffset: number
  count: number
}
interface V8Function {
  functionName: string
  ranges: V8Range[]
}
interface Observed {
  url: string
  functions: V8Function[]
  info: {
    code: string
    wrapperLength: number
    map: SourceMapV3 | null
    transformKey: string
    path: string
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const PROJECT_LOADER = join(here, 'project.ts')

/** Runs in the child: load the entry under precise coverage and print what V8 and the loader know. */
const CHILD = `
import { Session } from 'node:inspector/promises'
import { neutralPolicy } from '@provino/policy'
const { createProjectLoader } = await import(${JSON.stringify(PROJECT_LOADER)})
const root = process.argv[1]
const session = new Session()
session.connect()
await session.post('Profiler.enable')
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
const loader = await createProjectLoader(
  root,
  { hoist: null, moduleScope: [], extensions: ['.ts', '.js', '.cjs', '.json'], conditions: ['node'], tsconfig: false, mappers: [], typescript: 'oxc' },
  neutralPolicy.module,
)
const registry = loader.createFileRegistry(root + '/entry.ts', { tier: 'registry' })
await registry.import(root + '/entry.ts')
const { result } = await session.post('Profiler.takePreciseCoverage')
await session.post('Profiler.stopPreciseCoverage')
session.disconnect()
const observed = []
for (const script of result) {
  const info = loader.compiledModule(script.url)
  if (info !== null) observed.push({ url: script.url, functions: script.functions, info })
}
process.stdout.write(JSON.stringify(observed))
`

function observe(root: string): Observed[] {
  const env = { ...process.env }
  // `node --test` marks its children; this one is not a test.
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(
    process.execPath,
    ['--conditions=provino-source', '--input-type=module', '-e', CHILD, root],
    {
      cwd: join(here, '..'),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    },
  )
  assert.equal(run.status, 0, `the child failed (${run.status}): ${run.stderr}`)
  return JSON.parse(run.stdout) as Observed[]
}

/** The 1-based line of the marker `// @name` in a fixture. */
function markerLine(file: string, name: string): number {
  const lines = (FILES[file] ?? '').split('\n')
  const index = lines.findIndex((line) => line.endsWith(` // @${name}`))
  assert.notEqual(index, -1, `${file} has no marker @${name}`)
  return index + 1
}

interface Mapped {
  /** The source line, 1-based; 0 when the offset has no source position (generated code). */
  line: number
  column: number
}

/** An offset of the script, as a position in the source file (0 when it has none). */
function toSource(seen: Observed, offset: number): Mapped {
  const bodyOffset = offset - seen.info.wrapperLength
  if (bodyOffset < 0) return { line: 0, column: 0 }
  const before = seen.info.code.slice(0, bodyOffset)
  const generated = {
    line: before.split('\n').length,
    column: bodyOffset - (before.lastIndexOf('\n') + 1),
  }
  if (seen.info.map === null) return generated
  const found = originalPositionFor(new TraceMap(seen.info.map as never), generated)
  return { line: found.line ?? 0, column: found.column ?? 0 }
}

/** A function range expected at these markers, by function name and count. */
interface Expected {
  readonly name: string
  readonly count: number
  readonly start: string
  readonly end: string
  /** The text a declaration starts with: its column is held exact. */
  readonly startText?: string
}

const EXPECTED: Readonly<Record<string, readonly Expected[]>> = {
  'esm.ts': [
    { name: 'pick', count: 1, start: 'pick', end: 'pick-end', startText: 'function pick' },
    { name: 'pick', count: 0, start: 'else', end: 'else-end' },
    { name: 'arrow', count: 1, start: 'arrow', end: 'arrow' },
    { name: 'unused', count: 0, start: 'unused', end: 'unused-end', startText: 'function unused' },
    { name: 'later', count: 1, start: 'later', end: 'later' },
  ],
  'tla.ts': [
    { name: 'twice', count: 1, start: 'twice', end: 'twice-end', startText: 'function twice' },
  ],
  'shebang.cjs': [
    {
      name: 'shebang',
      count: 1,
      start: 'shebang',
      end: 'shebang-end',
      startText: 'function shebang',
    },
    {
      name: 'shebangUnused',
      count: 0,
      start: 'shebang-unused',
      end: 'shebang-unused',
      startText: 'function shebangUnused',
    },
  ],
}

/** The ranges of a script that are the user's, with the generated ones counted apart. */
function userRanges(seen: Observed): {
  readonly user: { fn: string; range: V8Range }[]
  readonly generated: { fn: string; range: V8Range }[]
} {
  const user: { fn: string; range: V8Range }[] = []
  const generated: { fn: string; range: V8Range }[] = []
  for (const fn of seen.functions) {
    for (const range of fn.ranges) {
      // The wrapper function itself, and the module's whole body inside it, start before the code.
      if (range.startOffset <= seen.info.wrapperLength) continue
      const start = toSource(seen, range.startOffset)
      ;(start.line === 0 ? generated : user).push({ fn: fn.functionName, range })
    }
  }
  return { user, generated }
}

test('T2.9: V8 ranges map to the marked source lines with zero offset errors', () => {
  const root = writeTree()
  const observed = observe(root)
  let checked = 0
  let errors = 0
  const complaints: string[] = []
  const complain = (message: string): void => {
    errors++
    complaints.push(message)
  }

  for (const seen of observed) {
    const file = seen.info.path.slice(root.length + 1)
    const expectations = EXPECTED[file]
    const { user, generated } = userRanges(seen)
    // What no source position covers is what the runner wrote: the export getters.
    for (const { range } of generated) {
      const text = seen.info.code.slice(
        range.startOffset - seen.info.wrapperLength,
        range.endOffset - seen.info.wrapperLength,
      )
      if (!/^get\(\) \{ return [\w$]+; \}$/.test(text))
        complain(`${file}: unmapped range is not an export getter: ${text}`)
    }
    // A file the fixture marks: each expected range is there, on its lines.
    for (const want of expectations ?? []) {
      const found = user.filter(({ fn, range }) => fn === want.name && range.count === want.count)
      const startLine = markerLine(file, want.start)
      const endLine = markerLine(file, want.end)
      const hit = found.find(({ range }) => {
        const start = toSource(seen, range.startOffset)
        const end = toSource(seen, range.endOffset)
        return start.line === startLine && end.line === endLine
      })
      checked++
      if (hit === undefined) {
        const got = found.map(({ range }) => {
          const start = toSource(seen, range.startOffset)
          const end = toSource(seen, range.endOffset)
          return `${start.line}:${start.column}-${end.line}:${end.column}`
        })
        complain(
          `${file}: ${want.name} (count ${want.count}) expected on ${startLine}-${endLine}, got ${got.join(', ') || 'no range'}`,
        )
        continue
      }
      if (want.startText !== undefined) {
        const lines = (FILES[file] ?? '').split('\n')
        const column = (lines[startLine - 1] ?? '').indexOf(want.startText)
        const start = toSource(seen, hit.range.startOffset)
        if (start.column !== column) {
          complain(`${file}: ${want.name} starts at column ${start.column}, expected ${column}`)
        }
      }
    }
  }
  assert.deepEqual(complaints, [])
  assert.equal(errors, 0)
  // Every range the fixtures mark was found: 5 in esm.ts, 2 in shebang.cjs, 1 in tla.ts.
  assert.equal(checked, 8)
})

test('T2.9: code on line 1 is read past the wrapper, and a hashbang changes no offset', () => {
  const root = writeTree()
  const observed = observe(root)
  const one = observed.filter((seen) => seen.info.path.endsWith('oneline.cjs'))
  assert.equal(one.length, 1)
  const [seen] = one
  assert.ok(seen !== undefined)
  // The only line is line 1, so a wrapper length that is off by one moves every column.
  const text = FILES['oneline.cjs'] ?? ''
  const helper = seen.functions.find((fn) => fn.functionName === 'helper')
  assert.ok(helper?.ranges[0] !== undefined)
  const start = toSource(seen, helper.ranges[0].startOffset)
  assert.deepEqual(start, { line: 1, column: text.indexOf('function helper') })
  const never = seen.functions.find((fn) => fn.functionName === 'never')
  assert.ok(never?.ranges[0] !== undefined)
  assert.equal(never.ranges[0].count, 0)
  assert.deepEqual(toSource(seen, never.ranges[0].startOffset), {
    line: 1,
    column: text.indexOf('function never'),
  })
  // The hashbang file keeps its first line: the code is still read from line 2.
  const shebang = observed.find((seen) => seen.info.path.endsWith('shebang.cjs'))
  assert.ok(shebang !== undefined)
  assert.ok(shebang.info.code.startsWith('//'), 'the hashbang is a comment of the same length')
  assert.equal(shebang.info.code.length, (FILES['shebang.cjs'] ?? '').length)
})

test('T2.9: an async wrapper (top-level await) is read as the others are', () => {
  const root = writeTree()
  const observed = observe(root)
  const tla = observed.filter((seen) => seen.info.path.endsWith('tla.ts'))
  assert.equal(tla.length, 1)
  const [seen] = tla
  assert.ok(seen !== undefined)
  // `async function (…) {` is as long as the spaces that stand in for it in the sync form.
  const esm = observed.find((other) => other.info.path.endsWith('esm.ts'))
  assert.ok(esm !== undefined)
  assert.equal(seen.info.wrapperLength, esm.info.wrapperLength)
})
