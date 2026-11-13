// Source-mapped stacks: a frame in a module the loader compiled is at its line and column in the
// file as written. The loader runs the transform's output in module-runner form, where every
// import is one line of its own above the module's code and Oxc has reprinted the rest, so an
// unmapped frame below a multi-line import is lines off and a column off; and the wrapper opens on
// the body's first line, so an unmapped frame there is off by the wrapper's length.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import type { SerializedLoaderConfig } from '@provino/types'
import { createProjectLoader } from './project.ts'
import { installSourceMappedStacks } from './stacks.ts'

const roots: string[] = []
after(() => {
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
