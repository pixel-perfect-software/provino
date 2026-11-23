// Source-mapped stacks: a frame in a module the loader compiled is at its line and column in the
// file as written. The loader runs the transform's output in module-runner form, where every
// import is one line of its own above the module's code and Oxc has reprinted the rest, so an
// unmapped frame below a multi-line import is lines off and a column off; and the wrapper opens on
// the body's first line, so an unmapped frame there is off by the wrapper's length.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { neutralPolicy } from '@provino/policy'
import type { Loader, SerializedLoaderConfig, SourceMapV3 } from '@provino/types'
import { afterAll, test } from 'provino'
import { createProjectLoader } from './project.ts'
import { installSourceMappedStacks } from './stacks.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-stacks-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const CONFIG: SerializedLoaderConfig = {
  hoist: null,
  moduleScope: [],
  extensions: ['.ts', '.js', '.cjs', '.json'],
  conditions: ['node'],
  tsconfig: false,
  mappers: [],
  typescript: 'oxc',
}

/** The position of the first frame of `stack` in `file`, as `line:column`. */
function frameIn(stack: string | undefined, file: string): string | undefined {
  for (const line of (stack ?? '').split('\n')) {
    const at = line.lastIndexOf(`${file}:`)
    if (at !== -1) return /^:(\d+:\d+)/.exec(line.slice(at + file.length))?.[1]
  }
  return undefined
}

const ENTRY = [
  "import type { Shape } from './shape.ts'",
  'import {',
  '  first,',
  '  second,',
  '  third,',
  "} from './values.ts'",
  "import { other } from './other.ts'",
  '',
  'export function made(): Error {',
  '  const shape: Shape = { first, second, third, other }',
  '  return new Error(String(shape.first))',
  '}',
  '',
  'export function thrown(): never {',
  '    throw   new Error(String(second))',
  '}',
  '',
].join('\n')

const TREE = {
  'shape.ts':
    'export interface Shape { first: number; second: number; third: number; other: string }\n',
  'values.ts': 'export const first = 1\nexport const second = 2\nexport const third = 3\n',
  'other.ts': "export const other: string = 'other'\n",
  'entry.test.ts': ENTRY,
  'line-one.ts': "export const made: Error = new Error('one')\n",
  'line-one.cjs': "module.exports = new Error('one')\n",
}

test('a frame below a multi-line import is at the line and column the file has', async () => {
  const root = writeTree(TREE)
  const file = join(root, 'entry.test.ts')
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  const uninstall = installSourceMappedStacks(loader)
  try {
    const entry = await loader
      .createFileRegistry(file, { tier: 'registry' })
      .import<{ made(): Error; thrown(): never }>(file)
    assert.equal(frameIn(entry.made().stack, file), '11:10')
    let thrown: unknown
    try {
      entry.thrown()
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof Error)
    assert.equal(frameIn(thrown.stack, file), '15:13')
  } finally {
    uninstall()
  }
})

test('a frame on the first line is in the file’s columns, not the wrapper’s', async () => {
  const root = writeTree(TREE)
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  // No map: a CommonJS file runs as written, so V8's own column is the answer.
  const plain = registry.require<Error>(join(root, 'line-one.cjs'))
  assert.equal(frameIn(plain.stack, join(root, 'line-one.cjs')), '1:18')
  const uninstall = installSourceMappedStacks(loader)
  try {
    const file = join(root, 'line-one.ts')
    const { made } = await registry.import<{ made: Error }>(file)
    assert.equal(frameIn(made.stack, file), '1:28')
  } finally {
    uninstall()
  }
})

/** A stack made in this file, which Node loads as written: the loader never compiled it. */
function nativeFrame(): string | undefined {
  return new Error('native').stack?.split('\n')[1]
}

test('a file the loader did not compile keeps its frame, and the uninstall puts the formatter back', async () => {
  const before = Error.prepareStackTrace
  const plain = nativeFrame()
  const root = writeTree(TREE)
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  const uninstall = installSourceMappedStacks(loader)
  try {
    assert.notEqual(Error.prepareStackTrace, before)
    assert.equal(nativeFrame(), plain)
  } finally {
    uninstall()
  }
  assert.equal(Error.prepareStackTrace, before)
  uninstall()
  assert.equal(Error.prepareStackTrace, before)
  // A formatter installed after it is left alone.
  const again = installSourceMappedStacks(loader)
  const later = (error: Error): string => String(error)
  Error.prepareStackTrace = later
  again()
  assert.equal(Error.prepareStackTrace, later)
  Error.prepareStackTrace = before
})

/** One source-map segment, VLQ-encoded (the fields are deltas, here from zero). */
function segment(...fields: readonly number[]): string {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let text = ''
  for (const field of fields) {
    let value = field < 0 ? (-field << 1) | 1 : field << 1
    do {
      let digit = value & 31
      value >>>= 5
      if (value > 0) digit |= 32
      text += digits[digit]
    } while (value > 0)
  }
  return text
}

/**
 * A module whose own inline map puts its `new Error` (line 2, column 10) at `orig.ts:6:9`, as a
 * build step's output names the file it came from.
 */
function selfMapped(): string {
  const map = { version: 3, sources: ['orig.ts'], names: [], mappings: `;${segment(9, 0, 5, 8)}` }
  const inline = Buffer.from(JSON.stringify(map)).toString('base64')
  return [
    'export function boom() {',
    "  return new Error('mapped')",
    '}',
    `//# sourceMappingURL=data:application/json;base64,${inline}`,
    '',
  ].join('\n')
}

/** Runs `body` with Node's source maps on, then puts the setting back. */
async function withNodeSourceMaps(body: () => Promise<void>): Promise<void> {
  const was = process.sourceMapsEnabled
  process.setSourceMapsEnabled(true)
  try {
    await body()
  } finally {
    process.setSourceMapsEnabled(was)
  }
}

test('with Node’s source maps on, a compiled file’s own map moves its frame on, as Node’s would', async () => {
  const root = writeTree({ ...TREE, 'boom.js': selfMapped() })
  const file = join(root, 'boom.js')
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  const uninstall = installSourceMappedStacks(loader)
  try {
    const { boom } = await loader
      .createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
      .import<{ boom(): Error }>(file)
    // Off: the file's own map is not read, and the frame is where the file has it.
    assert.equal(frameIn(boom().stack, file), '2:10')
    await withNodeSourceMaps(async () => {
      assert.equal(frameIn(boom().stack, join(root, 'orig.ts')), '6:9')
      assert.equal(frameIn(boom().stack, file), undefined)
    })
  } finally {
    uninstall()
  }
})

// A guard, not a regression: Node's own formatter, which the installed one hands the frames to,
// maps a file Node loaded, and the loader's step must not get in its way.
test('with Node’s source maps on, a file Node loaded is still mapped by Node', async () => {
  const root = writeTree({ ...TREE, 'native.mjs': selfMapped() })
  const loader = await createProjectLoader(root, CONFIG, neutralPolicy.module)
  const uninstall = installSourceMappedStacks(loader)
  try {
    await withNodeSourceMaps(async () => {
      // Node records a module's map as it loads it, so the import is inside the window.
      const { boom }: { boom(): Error } = await import(pathToFileURL(join(root, 'native.mjs')).href)
      assert.equal(frameIn(boom().stack, join(root, 'orig.ts')), '6:9')
    })
  } finally {
    uninstall()
  }
})

/** A frame made in `file`, compiled by `vm` as the loader compiles, at `line` (1-based) of `code`. */
function errorFrom(file: string, code: string): Error {
  return (runInThisContext(code, { filename: file }) as () => Error)()
}

/** A loader that holds `map` for `file` and nothing else. */
function holding(file: string, map: SourceMapV3): Pick<Loader, 'getSourceMap'> {
  return { getSourceMap: (id) => (id === file ? map : null) }
}

/** The file's own map: one segment, at its line 1, column 1, into `orig.ts` line 1. */
const OWN_MAP_LINE_ONE = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(
  JSON.stringify({ version: 3, sources: ['orig.ts'], names: [], mappings: segment(0, 0, 0, 0) }),
).toString('base64')}`

test('with Node’s source maps on, a frame the loader’s map can’t place stays where V8 put it', async () => {
  const root = writeTree({})
  const file = join(root, 'compiled.js')
  // The error is made on line 3, which the record's map has no segment for (a line the loader
  // wrote); the file's own map would place line 1 only, and its nearest earlier entry is wrong.
  const code = [
    '(function () {',
    '  return () =>',
    '    new Error("x")',
    '})()',
    OWN_MAP_LINE_ONE,
  ].join('\n')
  writeFileSync(file, code)
  const record: SourceMapV3 = {
    version: 3,
    sources: [file],
    names: [],
    mappings: segment(0, 0, 0, 0),
  }
  const uninstall = installSourceMappedStacks(holding(file, record))
  try {
    await withNodeSourceMaps(async () => {
      const error = errorFrom(file, code)
      assert.equal(frameIn(error.stack, file), '3:5')
      assert.equal(frameIn(error.stack, join(root, 'orig.ts')), undefined)
    })
  } finally {
    uninstall()
  }
})

test('with Node’s source maps on, a record already mapped past the file is not moved again', async () => {
  const root = writeTree({})
  const file = join(root, 'compiled.js')
  const code = ['(function () {', '  return () => new Error("x")', '})()', OWN_MAP_LINE_ONE].join(
    '\n',
  )
  writeFileSync(file, code)
  // A hosted transformer's map, composed with the file's own: it ends at orig.ts, line 6, column 9.
  const record: SourceMapV3 = {
    version: 3,
    sources: ['orig.ts'],
    names: [],
    mappings: `;${segment(15, 0, 5, 8)}`,
  }
  const uninstall = installSourceMappedStacks(holding(file, record))
  try {
    await withNodeSourceMaps(async () => {
      const error = errorFrom(file, code)
      assert.equal(frameIn(error.stack, file), '6:9')
      assert.equal(frameIn(error.stack, join(root, 'orig.ts')), undefined)
    })
  } finally {
    uninstall()
  }
})
