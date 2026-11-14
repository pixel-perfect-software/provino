import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { jestDebugText } from './debug.ts'
import { loadJestFilter } from './filter.ts'
import type { JestGlobalConfig, JestProjectConfig } from './types.ts'

const dirs: string[] = []
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function filterModule(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provino-filter-unit-'))
  dirs.push(dir)
  const path = join(dir, 'filter.cjs')
  await writeFile(path, source)
  return path
}

describe('loadJestFilter (jest-core cli/index.ts L190-L219, SearchSource.ts L326-L351)', () => {
  it('is nothing without a filter, or with --skipFilter', async () => {
    const path = await filterModule('module.exports = () => ({ filtered: [] })')
    assert.equal(loadJestFilter({ filter: undefined, skipFilter: false }), undefined)
    assert.equal(loadJestFilter({ filter: path, skipFilter: true }), undefined)
  })

  it('keeps the paths the module returns, in the given order, and ignores any it invents', async () => {
    const path = await filterModule(
      "module.exports = (tests) => ({ filtered: [...tests].reverse().filter((t) => t !== '/b').concat(['/new']) })",
    )
    const filter = loadJestFilter({ filter: path, skipFilter: false })
    assert.deepEqual(await filter?.(['/a', '/b', '/c']), ['/a', '/c'])
  })

  it('awaits an async filter and runs `setup` first, once', async () => {
    const path = await filterModule(
      [
        'const calls = []',
        'module.exports = async (tests) => { calls.push("filter"); return { filtered: tests } }',
        'module.exports.setup = async () => { calls.push("setup") }',
        'module.exports.calls = calls',
      ].join('\n'),
    )
    const filter = loadJestFilter({ filter: path, skipFilter: false })
    await filter?.(['/a'])
    await filter?.(['/a'])
    const { createRequire } = await import('node:module')
    assert.deepEqual(createRequire(path)(path).calls, ['setup', 'filter', 'filter'])
  })

  it('raises what `setup` threw when the first project is filtered', async () => {
    const path = await filterModule(
      'module.exports = (t) => ({ filtered: t })\nmodule.exports.setup = async () => { throw new RangeError("no") }',
    )
    const filter = loadJestFilter({ filter: path, skipFilter: false })
    await assert.rejects(filter?.(['/a']) ?? Promise.reject(new Error('no filter')), RangeError)
  })

  it('throws Jest’s TypeError for a result with no `filtered` array', async () => {
    const path = await filterModule('module.exports = () => ({ filtered: "x" })')
    const filter = loadJestFilter({ filter: path, skipFilter: false })
    await assert.rejects(
      filter?.(['/a']) ?? Promise.reject(new Error('no filter')),
      new TypeError(`Filter ${path} did not return a valid test list`),
    )
  })

  it('throws the TypeError of reading `filtered` off nothing, as Jest does', async () => {
    const path = await filterModule('module.exports = () => undefined')
    const filter = loadJestFilter({ filter: path, skipFilter: false })
    await assert.rejects(
      filter?.(['/a']) ?? Promise.reject(new Error('no filter')),
      /Cannot read properties of undefined \(reading 'filtered'\)/,
    )
  })
})

describe('jestDebugText (jest-core lib/logDebugMessages.ts)', () => {
  it('is configs, globalConfig and version, in that order, two spaces of indent and a newline', () => {
    const text = jestDebugText(
      { rootDir: '/r', testPathPatterns: ['a'] } as unknown as JestGlobalConfig,
      [{ cwd: '/r' } as unknown as JestProjectConfig],
      '30.5.2',
    )
    assert.equal(
      text,
      `${JSON.stringify(
        {
          configs: [{ cwd: '/r' }],
          globalConfig: { rootDir: '/r', testPathPatterns: ['a'] },
          version: '30.5.2',
        },
        null,
        '  ',
      )}\n`,
    )
    assert.ok(text.startsWith('{\n  "configs": ['))
  })
})
