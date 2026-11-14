// T9.12, T9.16: `runProjects` with `selection` and `onlyFailures`, over the inline pool. A selection
// takes the place of the file filters; `onlyFailures` keeps the files whose history says they
// failed; the history of the files left out stays, and the recorded graph is written after a run.
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  affectedCachePaths,
  cacheDirectories,
  createResultsCache,
  openRecordedGraph,
  projectCacheKey,
  type RunProjectOptions,
  runProjects,
} from '@provino/orchestrator'
import { createReporterBus } from '@provino/reporters'
import type { AffectedSelection, Reporter } from '@provino/types'
import { Collect, type Project, runtimeProject, trackedProjects } from './support.ts'

const makeProject = trackedProjects()

const FILES: Readonly<Record<string, string>> = {
  'src/leaf.js': 'module.exports = { leaf: 1 }\n',
  'src/other.js': 'module.exports = { other: 1 }\n',
  'a.test.js':
    "const { leaf } = require('./src/leaf')\ntest('a', () => { if (leaf !== 1) throw new Error('a') })\n",
  'b.test.js':
    "const { other } = require('./src/other')\ntest('b', () => { throw new Error('b fails') })\n",
  'c.test.js': "require('./src/leaf')\ntest('c', () => {})\n",
}

/** The files a run ran, and how each ended. */
async function runIt(
  p: Project,
  options: Partial<RunProjectOptions>,
  cacheDir = join(p.dir, '.cache'),
): Promise<Record<string, string>> {
  const ended: Record<string, string> = {}
  const reporter: Reporter = {
    name: 'ended',
    'file:end': (result) => {
      ended[result.file.path] = result.state
    },
  }
  await runProjects([runtimeProject(p.dir)], {
    bus: createReporterBus([reporter]),
    stderr: new Collect(),
    pool: { kind: 'inline' },
    cache: createResultsCache(cacheDir),
    ...options,
  })
  return ended
}

const related = (...paths: string[]): AffectedSelection => ({ kind: 'related', paths })

describe('selection', () => {
  it('runs the tests a leaf reaches and no others, whatever the file filters say', async () => {
    const p = await makeProject(FILES)
    const ended = await runIt(p, {
      selection: related(p.path('src/leaf.js')),
      // Jest ignores path patterns in related mode: this one would keep only b.test.js.
      fileFilters: [{ kind: 'regex', value: 'b\\.test' }],
    })
    assert.deepEqual(ended, { 'a.test.js': 'pass', 'c.test.js': 'pass' })
  })

  it('a selection by changed files is the same selection', async () => {
    const p = await makeProject(FILES)
    const changed = { changedFiles: [p.path('src/other.js')], repos: { git: [], hg: [], sl: [] } }
    const ended = await runIt(p, { selection: { kind: 'changed', changed } })
    assert.deepEqual(ended, { 'b.test.js': 'fail' })
  })

  it('a selection that reaches nothing is a run with no files', async () => {
    const p = await makeProject(FILES)
    assert.deepEqual(await runIt(p, { selection: related(p.path('unrelated.js')) }), {})
  })

  it('leaves the history of the files it did not run, and the next run can use it', async () => {
    const p = await makeProject(FILES)
    await runIt(p, {})
    const ended = await runIt(p, { selection: related(p.path('src/leaf.js')) })
    assert.deepEqual(Object.keys(ended).sort(), ['a.test.js', 'c.test.js'])
    // b.test.js was not run, and its failure is still on record.
    assert.deepEqual(await runIt(p, { onlyFailures: 'history' }), { 'b.test.js': 'fail' })
  })
})

describe('onlyFailures', () => {
  it('runs nothing before there is a history, and only the failed files after one', async () => {
    const p = await makeProject(FILES)
    assert.deepEqual(await runIt(p, { onlyFailures: 'history' }), {})
    await runIt(p, {})
    assert.deepEqual(await runIt(p, { onlyFailures: 'history' }), { 'b.test.js': 'fail' })
  })

  it('a set of paths names the files to keep', async () => {
    const p = await makeProject(FILES)
    const ended = await runIt(p, { onlyFailures: new Set([p.path('c.test.js')]) })
    assert.deepEqual(ended, { 'c.test.js': 'pass' })
  })

  it('combines with a selection: the failed files among the ones it reaches', async () => {
    const p = await makeProject(FILES)
    await runIt(p, {})
    const ended = await runIt(p, {
      selection: related(p.path('src/leaf.js'), p.path('src/other.js')),
      onlyFailures: 'history',
    })
    assert.deepEqual(ended, { 'b.test.js': 'fail' })
  })

  it('history without a results cache is ORCH_BAD_OPTION', async () => {
    const p = await makeProject(FILES)
    await assert.rejects(runIt(p, { cache: false, onlyFailures: 'history' }), {
      code: 'ORCH_BAD_OPTION',
    })
  })
})

describe('the recorded graph', () => {
  it('a run records what each test file loaded, and the next selection is a strict subset of the sources’', async () => {
    const p = await makeProject({
      ...FILES,
      // Imports `other` statically in the sources, but only inside a function the test never calls.
      'src/lazy.js': "module.exports = () => require('./other')\n",
      'd.test.js':
        "const lazy = require('./src/lazy')\ntest('d', () => { if (!lazy) throw new Error('d') })\n",
    })
    const project = runtimeProject(p.dir)
    const results = cacheDirectories(project).results
    const staticOnly = await runIt(p, {
      selection: related(p.path('src/other.js')),
      cache: false,
    })
    assert.deepEqual(Object.keys(staticOnly).sort(), ['b.test.js', 'd.test.js'])

    await runIt(p, {})
    const graph = await openRecordedGraph(
      affectedCachePaths(results, projectCacheKey(project)).deps,
    )
    const loaded = graph.get(p.path('d.test.js'))?.deps ?? []
    assert.ok(loaded.includes(p.path('src/lazy.js')))
    assert.ok(!loaded.includes(p.path('src/other.js')))

    const recorded = await runIt(p, { selection: related(p.path('src/other.js')) })
    assert.deepEqual(Object.keys(recorded), ['b.test.js'])
  })

  /** The record a run left for `test`, read back from the project's deps file. */
  async function recordOf(p: Project, test: string) {
    const project = runtimeProject(p.dir)
    const graph = await openRecordedGraph(
      affectedCachePaths(cacheDirectories(project).results, projectCacheKey(project)).deps,
    )
    return graph.get(p.path(test))
  }

  // One test's body loads `other`; the other test doesn't.
  const PARTIAL: Readonly<Record<string, string>> = {
    ...FILES,
    'e.test.js': "test('x loads other', () => { require('./src/other') })\ntest('y', () => {})\n",
    'f.test.js':
      "test.skip('x loads other', () => { require('./src/other') })\ntest('y', () => {})\n",
  }

  it('a run with -t records nothing, so a test it filtered out is still selected by its sources', async () => {
    const p = await makeProject(PARTIAL)
    await runIt(p, { testNamePattern: '^y$' })
    assert.equal(await recordOf(p, 'e.test.js'), undefined)
    const ended = await runIt(p, { selection: related(p.path('src/other.js')) })
    assert.ok('e.test.js' in ended, JSON.stringify(ended))
  })

  it('a file with a skipped test records nothing either', async () => {
    const p = await makeProject(PARTIAL)
    await runIt(p, {})
    assert.equal(await recordOf(p, 'f.test.js'), undefined)
    assert.ok((await recordOf(p, 'e.test.js')) !== undefined, 'a whole run records')
    const ended = await runIt(p, { selection: related(p.path('src/other.js')) })
    assert.ok('f.test.js' in ended, JSON.stringify(ended))
  })

  it('a record is stamped when the file was taken: a save while it runs leaves it stale', async () => {
    const p = await makeProject({
      'src/leaf.js': 'module.exports = { leaf: 1 }\n',
      // The test saves its own file, as an editor would while it runs. The clock is read until it
      // moves on, so the save is strictly after the file was taken and strictly before it ends.
      'a.test.js': [
        "const fs = require('fs')",
        "const path = require('path')",
        "require('./src/leaf')",
        "test('a', () => {",
        '  const tick = () => { const t = Date.now(); while (Date.now() <= t) {} }',
        '  tick()',
        "  const self = path.join(__dirname, 'a.test.js')",
        "  fs.writeFileSync(self, fs.readFileSync(self, 'utf8'))",
        '  tick()',
        '})',
        '',
      ].join('\n'),
    })
    assert.deepEqual(await runIt(p, {}), { 'a.test.js': 'pass' })
    const record = await recordOf(p, 'a.test.js')
    assert.ok(record !== undefined)
    const { mtimeMs } = await stat(p.path('a.test.js'))
    assert.ok(record.at < mtimeMs, `recorded at ${record.at}, saved at ${mtimeMs}`)
  })
})
