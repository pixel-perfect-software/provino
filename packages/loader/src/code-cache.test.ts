// B23e: V8's code cache for the loader's wrapper scripts (`LoaderOptions.codeCache`,
// `@provino/transform/v8cache`'s packs). Whether V8 read an entry is seen in a fresh process only
// (V8's per-isolate compilation cache serves a source it compiled before and ignores `cachedData`),
// so those tests load the fixture in a child, through the records and a registry, and print what
// the code cache counted and what V8 said of each script. When the loader writes, and whether a
// project loader has a code cache at all, are read from the packs on disk, here.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { neutralPolicy } from '@provino/policy'
import type { CoverageInstrumenter, SerializedLoaderConfig } from '@provino/types'
import { afterAll, test } from 'provino'
import { CODE_CACHE_WRITE_BATCH } from './internal/records.ts'
import { loaderOptionsFor } from './internal/test-support.ts'
import { createLoader } from './loader.ts'
import { createProjectLoader, type ProjectLoaderOptions } from './project.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = tempDir('provino-code-cache-')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** `count` CommonJS modules behind one index, each with a function the index calls. */
function graph(count: number): Record<string, string> {
  const files: Record<string, string> = {}
  const lines: string[] = []
  for (let index = 0; index < count; index++) {
    files[`lib/m${index}.cjs`] =
      `exports.value = function value(n) {\n  if (n > ${index}) return n * 2\n  return n + ${index}\n}\n`
    lines.push(`total += require('./lib/m${index}.cjs').value(${index + 1})`)
  }
  files['index.cjs'] = `let total = 0\n${lines.join('\n')}\nmodule.exports = total\n`
  return files
}

/** What `graph(count)`'s index evaluates to. */
function graphValue(count: number): number {
  let total = 0
  for (let index = 0; index < count; index++) total += (index + 1) * 2
  return total
}

/** The packs in `<dir>/v8`, by name. */
function packs(dir: string): string[] {
  const packDir = join(dir, 'v8')
  return existsSync(packDir) ? readdirSync(packDir).sort() : []
}

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Runs in the child: the fixture's index through the worker's records and one registry, with the
 * code cache in `dir`, then the write a file's end makes. Prints the counts and, for each script,
 * what V8 said of the data it was given (`null` for none).
 */
const CHILD = `
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
const { createRecords } = await import(${JSON.stringify(join(here, 'internal', 'records.ts'))})
const { Registry } = await import(${JSON.stringify(join(here, 'internal', 'registry.ts'))})
const [root, dir] = process.argv.slice(1)
const state = createRecords({
  root,
  engine: 'runner',
  resolver: createResolver({ root, mappers: [], extensions: ['.cjs', '.js'], tsconfig: false }),
  transformer: createPipeline({ root, typescript: 'oxc', tsconfig: false, hoist: null, cache: false }),
  policy: neutralPolicy.module,
  codeCache: dir,
})
const registry = new Registry(state)
const value = registry.loadSync(root + '/index.cjs', root + '/index.cjs', true)
const pending = state.codeCache.pending
state.codeCache.write()
const rejected = [...state.records.values()].map((record) => record.compiledSync?.script.cachedDataRejected ?? null)
state.codeCache.close()
process.stdout.write(JSON.stringify({ value, pending, stats: state.codeCache.stats, rejected }))
`

interface Loaded {
  readonly value: number
  readonly pending: number
  readonly stats: {
    readonly hits: number
    readonly misses: number
    readonly rejected: number
    readonly written: number
    readonly writeFailures: number
  }
  readonly rejected: readonly (boolean | null)[]
}

function load(root: string, dir: string): Loaded {
  const env = { ...process.env }
  // `node --test` marks its children; this one is not a test.
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(
    process.execPath,
    ['--conditions=provino-source', '--input-type=module', '-e', CHILD, root, dir],
    { cwd: join(here, '..'), encoding: 'utf8', timeout: 60_000, env },
  )
  assert.equal(run.status, 0, `the child failed (${run.status}): ${run.stderr}`)
  return JSON.parse(run.stdout) as Loaded
}

const MODULES = 20
/** The index and its modules: one script each. */
const SCRIPTS = MODULES + 1

test('a warm worker compiles every wrapper from the code cache, and V8 accepts each entry', () => {
  const root = writeTree(graph(MODULES))
  const dir = tempDir('provino-code-cache-dir-')
  const cold = load(root, dir)
  assert.equal(cold.value, graphValue(MODULES))
  assert.equal(cold.pending, SCRIPTS)
  assert.equal(cold.stats.misses, SCRIPTS)
  assert.equal(cold.stats.written, SCRIPTS)
  assert.deepEqual(cold.rejected, Array(SCRIPTS).fill(null))
  assert.equal(packs(dir).length, 1)

  const warm = load(root, dir)
  assert.equal(warm.value, graphValue(MODULES))
  assert.equal(warm.stats.hits, SCRIPTS)
  assert.equal(warm.stats.misses + warm.stats.rejected, 0)
  assert.equal(warm.pending, 0)
  // `false`, not `null`: V8 was given each script's data and took it.
  assert.deepEqual(warm.rejected, Array(SCRIPTS).fill(false))
  assert.equal(packs(dir).length, 1)
})

test('an edited module misses alone, even at the same length; the others still hit', () => {
  const root = writeTree(graph(MODULES))
  const dir = tempDir('provino-code-cache-dir-')
  load(root, dir)
  // `* 2` becomes `* 3`: the same length, so V8 alone would take the old entry and run old code.
  const edited = join(root, 'lib', 'm3.cjs')
  writeFileSync(edited, readFileSync(edited, 'utf8').replace('n * 2', 'n * 3'))
  const after = load(root, dir)
  assert.equal(after.value, graphValue(MODULES) + 4)
  assert.equal(after.stats.misses, 1)
  assert.equal(after.stats.hits, SCRIPTS - 1)
  assert.equal(after.stats.written, 1)
  assert.equal(load(root, dir).stats.hits, SCRIPTS)
})

test('an entry whose bytes were damaged is rejected, compiled from its source and rewritten', () => {
  const root = writeTree(graph(MODULES))
  const dir = tempDir('provino-code-cache-dir-')
  load(root, dir)
  const [pack] = packs(dir)
  const file = join(dir, 'v8', pack ?? '')
  const bytes = readFileSync(file)
  // The last entry's data ends the file.
  bytes[bytes.length - 8] = (bytes[bytes.length - 8] as number) ^ 0x55
  writeFileSync(file, bytes)
  const damaged = load(root, dir)
  assert.equal(damaged.value, graphValue(MODULES))
  assert.equal(damaged.stats.rejected, 1)
  assert.equal(damaged.stats.hits, SCRIPTS - 1)
  assert.equal(damaged.stats.written, 1)
  const healed = load(root, dir)
  assert.equal(healed.stats.hits, SCRIPTS)
  assert.deepEqual(healed.rejected, Array(SCRIPTS).fill(false))
})

test(`a file's end writes once ${CODE_CACHE_WRITE_BATCH} scripts wait; fewer wait for the loader's dispose`, () => {
  const count = CODE_CACHE_WRITE_BATCH + 6
  const root = writeTree({ ...graph(count), 'late.cjs': 'module.exports = 1\n' })
  const dir = tempDir('provino-code-cache-dir-')
  const loader = createLoader({ ...loaderOptionsFor(root), codeCache: dir })
  const index = join(root, 'index.cjs')
  const first = loader.createFileRegistry(index, { tier: 'registry' })
  assert.equal(first.require(index), graphValue(count))
  assert.deepEqual(packs(dir), [])
  first.dispose()
  // The first file compiled the whole graph: its end wrote it.
  assert.equal(packs(dir).length, 1)
  // A later file that compiles one new script leaves it waiting.
  const second = loader.createFileRegistry(index, { tier: 'registry' })
  second.require(index)
  assert.equal(second.require(join(root, 'late.cjs')), 1)
  second.dispose()
  assert.equal(packs(dir).length, 1)
  loader[Symbol.dispose]()
  assert.equal(packs(dir).length, 2)
})

const CONFIG: SerializedLoaderConfig = {
  hoist: null,
  moduleScope: [],
  extensions: ['.js', '.cjs', '.json'],
  conditions: ['node'],
  tsconfig: false,
  mappers: [],
  typescript: 'oxc',
}

/** A project loader that loads the graph in one file and is disposed; returns where packs could be. */
async function runProject(
  cacheDir: string | undefined,
  options: ProjectLoaderOptions,
): Promise<string> {
  const root = writeTree(graph(3))
  const loader = await createProjectLoader(
    root,
    cacheDir === undefined ? CONFIG : { ...CONFIG, cacheDir },
    neutralPolicy.module,
    options,
  )
  const index = join(root, 'index.cjs')
  const registry = loader.createFileRegistry(index, { tier: 'registry' })
  assert.equal(registry.require(index), graphValue(3))
  registry.dispose()
  loader[Symbol.dispose]()
  return root
}

/** Every `.pack` file under `dir`, at any depth. */
function packsUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.pack'))
}

const NO_INSTRUMENT: CoverageInstrumenter = {
  name: 'none',
  instrument: (code) => ({ code, map: null }),
}

test("a project loader keeps a code cache in its transform cache's directory with codeCache 'on'", async () => {
  const cacheDir = tempDir('provino-code-cache-t-')
  await runProject(cacheDir, { codeCache: 'on' })
  assert.equal(packs(cacheDir).length, 1)
})

test('a project loader keeps none under --no-cache, with codeCache off or left out, or under coverage', async () => {
  // `--no-cache`: no transform cache directory, so nowhere for a code cache, whatever is asked.
  const root = await runProject(undefined, { codeCache: 'on' })
  assert.deepEqual(packsUnder(root), [])
  for (const options of [
    { codeCache: 'off' },
    {},
    // Istanbul's instrumenter: no code cache under coverage (T3.7), whatever `codeCache` says.
    { codeCache: 'on', coverage: { instrumenter: NO_INSTRUMENT, shouldInstrument: () => false } },
  ] satisfies ProjectLoaderOptions[]) {
    const cacheDir = tempDir('provino-code-cache-t-')
    await runProject(cacheDir, options)
    assert.deepEqual(packs(cacheDir), [], JSON.stringify(Object.keys(options)))
  }
})
