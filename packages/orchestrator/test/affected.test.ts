// T9.12: the affected-test index over temp trees generated as text (D13): a change to a leaf selects
// exactly the tests whose closure holds it, a config change selects the project (or nothing, by the
// policy), the recorded graph is a strict subset of the static one, mocks and snapshots are edges,
// a warm cache answers as a cold one, and a file outside the roots is ignored. No real waits:
// mtimes are set by `utimes`.
import assert from 'node:assert/strict'
import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ResolvedProject } from '@provino/config'
import { createCoordinatorLoader } from '@provino/loader'
import {
  type AffectedIndex,
  type AffectedIndexOptions,
  createAffectedIndex,
  openRecordedGraph,
} from '@provino/orchestrator'
import type { DependencyExtractor } from '@provino/types'
import { type Project, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const disposals: Disposable[] = []
afterEach(() => {
  for (const disposable of disposals.splice(0)) disposable[Symbol.dispose]()
})

type Affected = ResolvedProject['policy']['orchestrator']['affected']

interface Built {
  readonly project: ResolvedProject
  readonly index: AffectedIndex
}

/** An index over `p`, with a cache directory of its own (outside the project's roots). */
async function build(
  p: Project,
  options: {
    readonly affected?: Partial<Affected>
    readonly cacheDir?: string
    readonly index?: Partial<AffectedIndexOptions>
    readonly project?: (project: ResolvedProject) => ResolvedProject
  } = {},
): Promise<Built> {
  const resolved = runtimeProject(p.dir, { include: ['**/*.test.ts'] })
  // The overrides go on the resolved policy: a closure or a `null` group is not a policy layer.
  const base: ResolvedProject = {
    ...resolved,
    policy: {
      ...resolved.policy,
      orchestrator: {
        ...resolved.policy.orchestrator,
        affected: { ...resolved.policy.orchestrator.affected, ...options.affected },
      },
    },
  }
  const project = options.project?.(base) ?? base
  const loader = await createCoordinatorLoader(p.dir, project.config.loader, project.policy.module)
  disposals.push(loader)
  const index = await createAffectedIndex(project, {
    cacheDir: options.cacheDir ?? `${p.dir}.cache`,
    projectKey: 'affected-test',
    loader,
    ...options.index,
  })
  return { project, index }
}

/** The T9.12 fixture monorepo, rebuilt: a leaf, a middle, an unrelated chain and four tests. */
const MONOREPO: Readonly<Record<string, string>> = {
  'src/leaf.ts': 'export const leaf = 1\n',
  'src/mid.ts': "import { leaf } from './leaf'\nexport const mid = leaf + 1\n",
  'src/other.ts': 'export const other = 2\n',
  'a.test.ts': "import { mid } from './src/mid'\ntest('a', () => mid)\n",
  'b.test.ts': "import { other } from './src/other'\ntest('b', () => other)\n",
  'c.test.ts':
    "import { leaf } from './src/leaf'\nimport { mid } from './src/mid'\ntest('c', () => leaf + mid)\n",
  'd.test.ts': "const { leaf } = require('./src/leaf')\ntest('d', () => leaf)\n",
}

const names = (p: Project, paths: readonly string[]): string[] =>
  paths.map((path) => path.slice(p.dir.length + 1))

/** Moves every file of `p` an hour into the past, so no edge-cache entry of it is racily clean. */
async function backdate(p: Project): Promise<void> {
  const past = new Date(Date.now() - 3_600_000)
  for (const entry of await readdir(p.dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), past, past)
  }
}

/** A tree whose `#dep` subpath import lands on `browser.ts` under `browser`, else `main.ts`. */
const CONDITIONAL: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    imports: { '#dep': { browser: './browser.ts', default: './main.ts' } },
  }),
  'browser.ts': 'export const where = 1\n',
  'main.ts': 'export const where = 2\n',
  'a.test.ts': "import { where } from '#dep'\ntest('a', () => where)\n",
}

/** A project whose environment resolves with `browser` (as jsdom's does). */
const browserEnvironment = (project: ResolvedProject): ResolvedProject => ({
  ...project,
  config: { ...project.config, loader: { ...project.config.loader, conditions: ['browser'] } },
})

describe('the closure of a change', () => {
  it('a change to a leaf selects exactly the tests whose static closure holds it', async () => {
    const p = await makeProject(MONOREPO)
    const { index } = await build(p)
    assert.deepEqual(names(p, index.related([p.path('src/leaf.ts')])), [
      'a.test.ts',
      'c.test.ts',
      'd.test.ts',
    ])
    assert.deepEqual(names(p, index.related([p.path('src/mid.ts')])), ['a.test.ts', 'c.test.ts'])
    assert.deepEqual(names(p, index.related([p.path('src/other.ts')])), ['b.test.ts'])
  })

  it('a changed test file selects itself, and several changes select the union', async () => {
    const p = await makeProject(MONOREPO)
    const { index } = await build(p)
    assert.deepEqual(names(p, index.related([p.path('b.test.ts')])), ['b.test.ts'])
    assert.deepEqual(names(p, index.related([p.path('b.test.ts'), p.path('src/mid.ts')])), [
      'a.test.ts',
      'b.test.ts',
      'c.test.ts',
    ])
  })

  it('a cycle between sources ends, and its tests are selected', async () => {
    const p = await makeProject({
      'x.ts': "import './y'\nexport const x = 1\n",
      'y.ts': "import './x'\nexport const y = 1\n",
      'a.test.ts': "import './x'\n",
    })
    const { index } = await build(p)
    assert.deepEqual(names(p, index.related([p.path('y.ts')])), ['a.test.ts'])
  })

  it('a file outside the roots is ignored, even one a test imports', async () => {
    const p = await makeProject({
      'pkg/a.test.ts': "import '../../outside'\n",
      'unrelated.ts': 'export {}\n',
    })
    const project = (base: ResolvedProject): ResolvedProject => ({
      ...base,
      rootDir: p.path('pkg'),
    })
    const { index } = await build(p, { project })
    const outside = join(dirname(p.dir), 'outside.ts')
    assert.deepEqual(index.related([outside, p.path('unrelated.ts')]), [])
    assert.deepEqual(names(p, index.related([p.path('pkg/a.test.ts')])), ['pkg/a.test.ts'])
  })

  it('a builtin a mapper takes is an edge to the mapped file; one no mapper takes is none, even with a root mock of its name', async () => {
    const p = await makeProject({
      'fs-stub.ts': 'export {}\n',
      '__mocks__/path.ts': 'export {}\n',
      'a.test.ts': "import 'fs'\nimport 'path'\ntest('a', () => {})\n",
    })
    const mapped = (project: ResolvedProject): ResolvedProject => ({
      ...project,
      config: {
        ...project.config,
        loader: {
          ...project.config.loader,
          aliases: [{ pattern: '^fs$', targets: ['<rootDir>/fs-stub.ts'] }],
        },
      },
    })
    const { index } = await build(p, {
      project: mapped,
      affected: { mockEdges: { dir: '__mocks__', adjacent: true, byName: true } },
    })
    assert.deepEqual(names(p, index.related([p.path('fs-stub.ts')])), ['a.test.ts'])
    assert.deepEqual(index.related([p.path('__mocks__/path.ts')]), [])
  })

  it('an edge resolves with the environment’s conditions under environment, and with require, node and default under none', async () => {
    const p = await makeProject(CONDITIONAL)
    const environment = await build(p, {
      affected: { conditions: 'environment' },
      project: browserEnvironment,
    })
    assert.deepEqual(names(p, environment.index.sourcesOf(p.path('a.test.ts'))), ['browser.ts'])
    assert.deepEqual(names(p, environment.index.related([p.path('browser.ts')])), ['a.test.ts'])
    assert.deepEqual(environment.index.related([p.path('main.ts')]), [])
    const none = await build(p, { affected: { conditions: 'none' }, project: browserEnvironment })
    assert.deepEqual(names(p, none.index.sourcesOf(p.path('a.test.ts'))), ['main.ts'])
    assert.deepEqual(names(p, none.index.related([p.path('main.ts')])), ['a.test.ts'])
    assert.deepEqual(none.index.related([p.path('browser.ts')]), [])
  })

  it('sourcesOf is a test file’s direct dependencies', async () => {
    const p = await makeProject(MONOREPO)
    const { index } = await build(p)
    assert.deepEqual(names(p, index.sourcesOf(p.path('c.test.ts'))).sort(), [
      'src/leaf.ts',
      'src/mid.ts',
    ])
  })
})

describe('a change to the project’s own inputs', () => {
  it('selects every test under project-inputs, and what the graph reaches under none', async () => {
    const p = await makeProject({
      ...MONOREPO,
      'package.json': '{}\n',
      'setup.ts': 'export {}\n',
      'provino.config.ts': 'export default {}\n',
    })
    const withSetup = (project: ResolvedProject): ResolvedProject => ({
      ...project,
      config: { ...project.config, setupFiles: [p.path('setup.ts')] },
    })
    const all = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']
    const strict = await build(p, {
      affected: { invalidateAll: 'project-inputs' },
      project: withSetup,
      index: { configFile: p.path('provino.config.ts') },
    })
    for (const input of ['package.json', 'setup.ts', 'provino.config.ts']) {
      assert.deepEqual(names(p, strict.index.related([p.path(input)])), all, input)
    }
    const lenient = await build(p, {
      affected: { invalidateAll: 'none' },
      project: withSetup,
      index: { configFile: p.path('provino.config.ts') },
    })
    for (const input of ['package.json', 'setup.ts', 'provino.config.ts']) {
      assert.deepEqual(lenient.index.related([p.path(input)]), [], input)
    }
  })
})

describe('the recorded graph', () => {
  const FILES: Readonly<Record<string, string>> = {
    // The barrel imports `used` statically and `heavy` only inside a function that never runs.
    'src/barrel.ts': "export * from './used'\nexport const later = () => require('./heavy')\n",
    'src/used.ts': 'export const used = 1\n',
    'src/heavy.ts': 'export const heavy = 1\n',
    'a.test.ts': "import { used } from './src/barrel'\ntest('a', () => used)\n",
    'b.test.ts': "import { heavy } from './src/heavy'\ntest('b', () => heavy)\n",
  }

  async function record(p: Project, cacheDir: string, deps: Readonly<Record<string, string[]>>) {
    const graph = await openRecordedGraph(join(cacheDir, 'affected', 'deps-affected-test.json'))
    for (const [test, loaded] of Object.entries(deps)) {
      // Later than the files' mtimes, which the tree just got.
      graph.record(
        p.path(test),
        loaded.map((name) => p.path(name)),
        Date.now() + 60_000,
      )
    }
    await graph.save()
    return graph
  }

  it('selects a strict subset of the static graph through a barrel', async () => {
    const p = await makeProject(FILES)
    const cacheDir = `${p.dir}.cache`
    const heavy = [p.path('src/heavy.ts')]
    const staticOnly = await build(p, { affected: { graph: 'static' }, cacheDir })
    assert.deepEqual(names(p, staticOnly.index.related(heavy)), ['a.test.ts', 'b.test.ts'])

    const recorded = await record(p, cacheDir, {
      'a.test.ts': ['a.test.ts', 'src/barrel.ts', 'src/used.ts'],
      'b.test.ts': ['b.test.ts', 'src/heavy.ts'],
    })
    const neutral = await build(p, {
      affected: { graph: 'recorded-then-static' },
      cacheDir,
      index: { recorded },
    })
    assert.deepEqual(names(p, neutral.index.related(heavy)), ['b.test.ts'])
    assert.deepEqual(names(p, neutral.index.related([p.path('src/used.ts')])), ['a.test.ts'])
  })

  it('falls back to the sources for a test whose record is older than one of its modules', async () => {
    const p = await makeProject(FILES)
    const cacheDir = `${p.dir}.cache`
    const recorded = await record(p, cacheDir, {
      'a.test.ts': ['a.test.ts', 'src/barrel.ts', 'src/used.ts'],
    })
    // A module saved after the record was made: the record can't be trusted.
    const later = new Date(Date.now() + 3_600_000)
    await utimes(p.path('src/barrel.ts'), later, later)
    const { index } = await build(p, {
      affected: { graph: 'recorded-then-static' },
      cacheDir,
      index: { recorded },
    })
    assert.deepEqual(names(p, index.related([p.path('src/heavy.ts')])), ['a.test.ts', 'b.test.ts'])
  })

  it('a test that imports a test with a fresh record still reaches what that one imports', async () => {
    const p = await makeProject({
      'src/dep.ts': 'export const d = 1\n',
      'b.test.ts': "import { d } from './src/dep'\nexport const b = d\ntest('b', () => b)\n",
      'a.test.ts': "import { b } from './b.test'\ntest('a', () => b)\n",
    })
    const cacheDir = `${p.dir}.cache`
    const staticOnly = await build(p, { affected: { graph: 'static' }, cacheDir })
    assert.deepEqual(names(p, staticOnly.index.related([p.path('src/dep.ts')])), [
      'a.test.ts',
      'b.test.ts',
    ])
    const recorded = await record(p, cacheDir, { 'b.test.ts': ['b.test.ts', 'src/dep.ts'] })
    const neutral = await build(p, {
      affected: { graph: 'recorded-then-static' },
      cacheDir,
      index: { recorded },
    })
    assert.deepEqual(names(p, neutral.index.related([p.path('src/dep.ts')])), [
      'a.test.ts',
      'b.test.ts',
    ])
  })

  it('keeps the modules’ mtimes between calls, and stats again only what update names', async () => {
    const p = await makeProject(FILES)
    const cacheDir = `${p.dir}.cache`
    const recorded = await record(p, cacheDir, {
      'a.test.ts': ['a.test.ts', 'src/barrel.ts', 'src/used.ts'],
    })
    const { index } = await build(p, {
      affected: { graph: 'recorded-then-static' },
      cacheDir,
      index: { recorded },
    })
    const heavy = [p.path('src/heavy.ts')]
    assert.deepEqual(names(p, index.related(heavy)), ['b.test.ts'])
    // A save the watcher has not reported yet changes nothing.
    const later = new Date(Date.now() + 3_600_000)
    await utimes(p.path('src/barrel.ts'), later, later)
    assert.deepEqual(names(p, index.related(heavy)), ['b.test.ts'])
    // Once it is reported, the record is older than the barrel and the sources decide.
    await index.update([{ kind: 'change', path: p.path('src/barrel.ts') }])
    assert.deepEqual(names(p, index.related(heavy)), ['a.test.ts', 'b.test.ts'])
  })

  it('does not read the record under the static graph', async () => {
    const p = await makeProject(FILES)
    const cacheDir = `${p.dir}.cache`
    const recorded = await record(p, cacheDir, { 'a.test.ts': ['a.test.ts', 'src/used.ts'] })
    const { index } = await build(p, {
      affected: { graph: 'static' },
      cacheDir,
      index: { recorded },
    })
    assert.deepEqual(names(p, index.related([p.path('src/heavy.ts')])), ['a.test.ts', 'b.test.ts'])
  })
})

describe('mocks and snapshots are edges', () => {
  const MOCKED: Readonly<Record<string, string>> = {
    'lib/util.ts': 'export const util = 1\n',
    'lib/__mocks__/util.ts': 'export const util = 2\n',
    '__mocks__/virtual-pkg.ts': 'export const virtual = 3\n',
    'a.test.ts': "import { util } from './lib/util'\ntest('a', () => util)\n",
    'b.test.ts': "import { virtual } from 'virtual-pkg'\ntest('b', () => virtual)\n",
  }

  it('the adjacent mock selects the tests of the file it replaces; a root mock by name only when the policy says', async () => {
    const p = await makeProject(MOCKED)
    const neutral = await build(p, {
      affected: { mockEdges: { dir: '__mocks__', adjacent: true, byName: false } },
    })
    assert.deepEqual(names(p, neutral.index.related([p.path('lib/__mocks__/util.ts')])), [
      'a.test.ts',
    ])
    assert.deepEqual(neutral.index.related([p.path('__mocks__/virtual-pkg.ts')]), [])
    const named = await build(p, {
      affected: { mockEdges: { dir: '__mocks__', adjacent: true, byName: true } },
    })
    assert.deepEqual(names(p, named.index.related([p.path('__mocks__/virtual-pkg.ts')])), [
      'b.test.ts',
    ])
    const none = await build(p, { affected: { mockEdges: null } })
    assert.deepEqual(none.index.related([p.path('lib/__mocks__/util.ts')]), [])
  })

  it('a changed .snap selects its test file, and a snapshot beside no test selects nothing', async () => {
    const p = await makeProject({
      'a.test.ts': 'test("a", () => {})\n',
      'b.test.ts': 'test("b", () => {})\n',
      '__snapshots__/a.test.ts.snap': '// Provino Snapshot v1\n',
      '__snapshots__/orphan.test.ts.snap': '// Provino Snapshot v1\n',
    })
    const { index } = await build(p)
    assert.deepEqual(names(p, index.related([p.path('__snapshots__/a.test.ts.snap')])), [
      'a.test.ts',
    ])
    assert.deepEqual(index.related([p.path('__snapshots__/orphan.test.ts.snap')]), [])
  })

  it('a .snap that is not in the tree (deleted) selects nothing, though its test is there', async () => {
    const p = await makeProject({
      'a.test.ts': 'test("a", () => {})\n',
      'b.test.ts': 'test("b", () => {})\n',
    })
    const { index } = await build(p)
    assert.deepEqual(index.related([p.path('__snapshots__/b.test.ts.snap')]), [])
  })
})

describe('the edge cache', () => {
  function counting(cacheKey: string): { calls: string[]; factory: () => DependencyExtractor } {
    const calls: string[] = []
    return {
      calls,
      factory: () => ({
        cacheKey,
        extract: (code, path, fallback) => {
          calls.push(path)
          return fallback(code)
        },
      }),
    }
  }

  it('a warm index answers as a cold one without reading a file again', async () => {
    const p = await makeProject(MONOREPO)
    await backdate(p)
    const cacheDir = `${p.dir}.cache`
    const cold = counting('v1')
    const first = await build(p, { affected: { extractor: cold.factory }, cacheDir })
    await first.index.save()
    const answer = first.index.related([p.path('src/leaf.ts')])
    assert.equal(cold.calls.length, 7, 'every file is read once, cold')

    const warm = counting('v1')
    const second = await build(p, { affected: { extractor: warm.factory }, cacheDir })
    assert.deepEqual(warm.calls, [], 'nothing is read again')
    assert.deepEqual(second.index.related([p.path('src/leaf.ts')]), answer)

    // A file whose size changed is read again, and the answer follows.
    await writeFile(p.path('src/other.ts'), "import './leaf'\nexport const other = 22\n")
    const edited = counting('v1')
    const third = await build(p, { affected: { extractor: edited.factory }, cacheDir })
    assert.deepEqual(names(p, edited.calls), ['src/other.ts'])
    assert.deepEqual(names(p, third.index.related([p.path('src/leaf.ts')])), [
      'a.test.ts',
      'b.test.ts',
      'c.test.ts',
      'd.test.ts',
    ])
  })

  it('another extractor key, or a corrupt cache file, reads everything again', async () => {
    const p = await makeProject(MONOREPO)
    const cacheDir = `${p.dir}.cache`
    const one = counting('v1')
    await (await build(p, { affected: { extractor: one.factory }, cacheDir })).index.save()
    const two = counting('v2')
    await build(p, { affected: { extractor: two.factory }, cacheDir })
    assert.equal(two.calls.length, 7)
    await mkdir(join(cacheDir, 'affected'), { recursive: true })
    await writeFile(join(cacheDir, 'affected', 'affected-test.json'), '{ not json')
    const three = counting('v2')
    await build(p, { affected: { extractor: three.factory }, cacheDir })
    assert.equal(three.calls.length, 7)
  })

  it('an entry an older Provino wrote under the same extractor name is not read', async () => {
    const p = await makeProject({
      'hidden.ts': 'export {}\n',
      'a.test.ts': "test('a', () => {})\n",
    })
    await backdate(p)
    const cacheDir = `${p.dir}.cache`
    const info = await stat(p.path('a.test.ts'))
    await mkdir(join(cacheDir, 'affected'), { recursive: true })
    // What the first edge cache wrote: the lexer's name alone, and an edge the file doesn't have.
    await writeFile(
      join(cacheDir, 'affected', 'affected-test.json'),
      JSON.stringify({
        version: 1,
        identity: 'lexer',
        files: {
          [p.path('a.test.ts')]: { m: info.mtimeMs, s: info.size, e: ['./hidden'], w: Date.now() },
        },
      }),
    )
    const { index } = await build(p, { cacheDir })
    assert.deepEqual(index.related([p.path('hidden.ts')]), [])
  })

  it('a file read in the tick it was saved is read again, though a later save left its mtime and size', async () => {
    const p = await makeProject({
      'one.ts': 'export {}\n',
      'two.ts': 'export {}\n',
      'a.test.ts': "import './one'\n",
    })
    const cacheDir = `${p.dir}.cache`
    // Saved just now (a whole millisecond, which `utimes` can set again exactly): the read below
    // lands within the file system's timestamp granularity.
    const savedAt = new Date()
    await utimes(p.path('a.test.ts'), savedAt, savedAt)
    const first = await build(p, { cacheDir })
    await first.index.save()
    // The same size, and the mtime a coarse clock gives a second save in the same tick.
    await writeFile(p.path('a.test.ts'), "import './two'\n")
    await utimes(p.path('a.test.ts'), savedAt, savedAt)
    // Rounded: ext4 on Node 22 reports a whole-millisecond mtime as 1794633568134.999.
    assert.equal(Math.round((await stat(p.path('a.test.ts'))).mtimeMs), savedAt.getTime())
    const second = await build(p, { cacheDir })
    assert.deepEqual(names(p, second.index.related([p.path('two.ts')])), ['a.test.ts'])
  })

  it('a null cache directory keeps nothing', async () => {
    const p = await makeProject(MONOREPO)
    const first = counting('v1')
    const { index } = await build(p, {
      affected: { extractor: first.factory },
      index: { cacheDir: null },
    })
    await index.save()
    const second = counting('v1')
    await build(p, { affected: { extractor: second.factory }, index: { cacheDir: null } })
    assert.equal(second.calls.length, 7)
  })
})

describe('extractors', () => {
  it('the project’s own extractor, an object module, is read before the policy’s', async () => {
    const p = await makeProject({
      'extractor.ts':
        "export default { cacheKey: 'p', extract: (code: string, _path: string, fallback: (c: string) => Iterable<string>) => [...fallback(code), './hidden'] }\n",
      'hidden.ts': 'export const hidden = 1\n',
      'a.test.ts': "test('a', () => {})\n",
    })
    const { index } = await build(p, {
      index: { projectExtractor: { module: p.path('extractor.ts'), export: 'default' } },
    })
    assert.deepEqual(names(p, index.related([p.path('hidden.ts')])), ['a.test.ts'])
  })

  it('a module that exports no extractor is ORCH_BAD_OPTION', async () => {
    const p = await makeProject({ 'extractor.ts': 'export default 1\n', 'a.test.ts': '' })
    await assert.rejects(
      build(p, {
        index: { projectExtractor: { module: p.path('extractor.ts'), export: 'default' } },
      }),
      { code: 'ORCH_BAD_OPTION' },
    )
  })

  it('the lexer reads imports, re-exports, import() and require, and skips type imports and JSON', async () => {
    const p = await makeProject({
      'a.ts': 'export const a = 1\n',
      'b.ts': 'export const b = 1\n',
      'c.ts': 'export const c = 1\n',
      'd.ts': 'export const d = 1\n',
      't.ts': 'export type T = 1\n',
      'data.json': '{ "x": "import \'./a\'" }\n',
      'x.test.ts': [
        "import { a } from './a'",
        "export { b } from './b'",
        "import type { T } from './t'",
        "const lazy = () => import('./c')",
        "const old = require('./d')",
        '',
      ].join('\n'),
    })
    const { index } = await build(p)
    assert.deepEqual(names(p, index.sourcesOf(p.path('x.test.ts'))).sort(), [
      'a.ts',
      'b.ts',
      'c.ts',
      'd.ts',
    ])
  })
})

describe('a tree that changes', () => {
  it('update: an added file resolves a specifier that missed, a changed file gets new edges, an unlinked one goes', async () => {
    const p = await makeProject({
      'a.test.ts': "import './later'\n",
      'b.test.ts': "import './b-dep'\n",
      'b-dep.ts': 'export {}\n',
      'c.ts': 'export {}\n',
    })
    const { index } = await build(p)
    assert.deepEqual(index.related([p.path('later.ts')]), [])
    await writeFile(p.path('later.ts'), 'export {}\n')
    await index.update([{ kind: 'add', path: p.path('later.ts') }])
    assert.deepEqual(names(p, index.related([p.path('later.ts')])), ['a.test.ts'])

    await writeFile(p.path('b.test.ts'), "import './c'\nimport './b-dep'\n")
    await index.update([{ kind: 'change', path: p.path('b.test.ts') }])
    assert.deepEqual(names(p, index.related([p.path('c.ts')])), ['b.test.ts'])

    await index.update([{ kind: 'unlink', path: p.path('b.test.ts') }])
    assert.deepEqual(index.related([p.path('c.ts')]), [])
    assert.ok(!index.files().tests.includes(p.path('b.test.ts')))
  })

  it('update: a changed package.json re-resolves every file', async () => {
    const p = await makeProject(CONDITIONAL)
    const { index } = await build(p)
    assert.deepEqual(names(p, index.related([p.path('main.ts')])), ['a.test.ts'])
    await writeFile(p.path('package.json'), JSON.stringify({ imports: { '#dep': './browser.ts' } }))
    await index.update([{ kind: 'change', path: p.path('package.json') }])
    assert.deepEqual(names(p, index.related([p.path('browser.ts')])), ['a.test.ts'])
    assert.deepEqual(index.related([p.path('main.ts')]), [])
  })

  it('update: an added file the crawl would leave out is not indexed', async () => {
    const p = await makeProject({ 'a.test.ts': "import 'pkg'\n" })
    const { index } = await build(p)
    const added = ['node_modules/pkg/index.test.ts', '.git/hooks/x.test.ts', 'notes.test.md'].map(
      (name) => p.path(name),
    )
    for (const path of added) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'export {}\n')
    }
    await index.update(added.map((path) => ({ kind: 'add' as const, path })))
    for (const path of added) assert.ok(!index.files().all.has(path), path)
    assert.deepEqual(names(p, index.files().tests), ['a.test.ts'])
  })

  it('update: a test added later has its snapshot found by the project’s own resolver', async () => {
    const p = await makeProject({
      'resolver.ts':
        'export const resolveSnapshotPath = (test: string, extension: string): string => test + extension\n',
      'a.test.ts': "test('a', () => {})\n",
    })
    const withResolver = (project: ResolvedProject): ResolvedProject => ({
      ...project,
      policy: {
        ...project.policy,
        snapshot: {
          ...project.policy.snapshot,
          resolvePath: { module: p.path('resolver.ts'), export: 'resolveSnapshotPath' },
        },
      },
    })
    const { index } = await build(p, { project: withResolver })
    const later = p.path('later.test.ts')
    const snap = `${later}.snap`
    await writeFile(later, "test('later', () => {})\n")
    await writeFile(snap, '// Provino Snapshot v1\n')
    await index.update([
      { kind: 'add', path: later },
      { kind: 'add', path: snap },
    ])
    assert.deepEqual(names(p, index.related([snap])), ['later.test.ts'])
  })
})
