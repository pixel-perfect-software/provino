// B13a's end-to-end check (Q2): `jest.fn` and its neighbours through a real `run()`, on forks and
// inline. The project is generated into $TMPDIR as text (no `.js` is committed, D13).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { PoolKind } from '@provino/types'
import { run } from 'provino/node'
import { Collect, type Project, trackedProjects, viewOfNormalized } from './support.ts'

const makeProject = trackedProjects()

/** Runs a project with the normalized-json reporter, and reads back the file. */
async function runWithJson(project: Project, pool: PoolKind) {
  const stdout = new Collect()
  const stderr = new Collect()
  const outputFile = project.path('out.json')
  const result = await run({
    config: project.config,
    pool,
    maxWorkers: 1,
    reporters: [['normalized-json', { outputFile }]],
    stdout,
    stderr,
  })
  const view = viewOfNormalized(await readFile(outputFile, 'utf8'))
  return { result, view, stderr: stderr.text }
}

for (const pool of ['forks', 'inline'] as const) {
  describe(`jest.fn and its neighbours through run() on ${pool}`, () => {
    it('records calls for the spy matchers, passing and failing', async () => {
      const project = await makeProject({
        'tests/fn.test.js': [
          "test('jest.fn records its calls', () => {",
          '  const fn = jest.fn((a, b) => a + b)',
          '  expect(fn(1, 2)).toBe(3)',
          '  expect(jest.isMockFunction(fn)).toBe(true)',
          '  expect(fn).toHaveBeenCalledTimes(1)',
          '  expect(fn).toHaveBeenCalledWith(1, 2)',
          '  expect(fn).toHaveReturnedWith(3)',
          '})',
          "test('a wrong toHaveBeenCalledWith fails', () => {",
          '  const fn = jest.fn()',
          '  fn(1)',
          '  expect(() => expect(fn).toHaveBeenCalledWith(9)).toThrow(/toHaveBeenCalledWith/)',
          '  expect(fn).toHaveBeenCalledWith(9)',
          '})',
          "test('clearAllMocks and resetAllMocks reach the file’s mocks', () => {",
          '  const fn = jest.fn(() => 1)',
          '  fn()',
          '  expect(jest.clearAllMocks()).toBe(jest)',
          '  expect(fn.mock.calls).toEqual([])',
          '  expect(fn()).toBe(1)',
          '  jest.resetAllMocks()',
          '  expect(fn()).toBeUndefined()',
          '})',
          '',
        ].join('\n'),
      })
      const { result, view, stderr } = await runWithJson(project, pool)
      const file = view.files.get('tests/fn.test.js')
      assert.equal(file?.tests.get('jest.fn records its calls'), 'passed', stderr)
      assert.equal(file?.tests.get('a wrong toHaveBeenCalledWith fails'), 'failed')
      assert.equal(
        file?.tests.get('clearAllMocks and resetAllMocks reach the file’s mocks'),
        'passed',
      )
      assert.equal(result.exitCode, 1)
    })

    it('spies on an export of a module the runner loaded, and restores it', async () => {
      const project = await makeProject({
        'lib.js': 'exports.double = (n) => n * 2\n',
        'use.js':
          "const lib = require('./lib.js')\nexports.quad = (n) => lib.double(lib.double(n))\n",
        'tests/spy.test.js': [
          "const lib = require('../lib.js')",
          "const { quad } = require('../use.js')",
          "test('spyOn sees calls made through another module', () => {",
          "  const spy = jest.spyOn(lib, 'double')",
          '  expect(quad(1)).toBe(4)',
          '  expect(spy).toHaveBeenCalledTimes(2)',
          '  expect(spy).toHaveBeenNthCalledWith(2, 2)',
          '  spy.mockReturnValue(10)',
          '  expect(quad(1)).toBe(10)',
          '  jest.restoreAllMocks()',
          '  expect(quad(1)).toBe(4)',
          '})',
          "test('replaceProperty puts the value back', () => {",
          '  const object = { n: 1 }',
          "  const replaced = jest.replaceProperty(object, 'n', 2)",
          '  expect(object.n).toBe(2)',
          '  replaced.restore()',
          '  expect(object.n).toBe(1)',
          '})',
          '',
        ].join('\n'),
      })
      const { result, view, stderr } = await runWithJson(project, pool)
      const file = view.files.get('tests/spy.test.js')
      assert.deepEqual(
        [...(file?.tests ?? [])],
        [
          ['spyOn sees calls made through another module', 'passed'],
          ['replaceProperty puts the value back', 'passed'],
        ],
        stderr,
      )
      assert.equal(result.exitCode, 0, stderr)
    })

    it('puts back a spy file A left on a global, so file B sees the real one (registry)', async () => {
      // The sequencer runs the larger file first when there is no history, and `maxWorkers: 1`
      // keeps both files in one worker. B checks A ran before it, through a marker file.
      const project = await makeProject((dir) => ({
        'tests/a.test.js': [
          "const { writeFileSync } = require('node:fs')",
          "test('a leaves a spy on Math.random', () => {",
          "  jest.spyOn(Math, 'random').mockReturnValue(0.5)",
          '  expect(Math.random()).toBe(0.5)',
          `  writeFileSync(${JSON.stringify(`${dir}/a.ran`)}, 'yes')`,
          '})',
          `// padding, so this file is larger and goes first ${'.'.repeat(300)}`,
          '',
        ].join('\n'),
        'tests/b.test.js': [
          "const { existsSync } = require('node:fs')",
          "test('b sees the real Math.random', () => {",
          `  expect(existsSync(${JSON.stringify(`${dir}/a.ran`)})).toBe(true)`,
          '  expect(jest.isMockFunction(Math.random)).toBe(false)',
          '  expect(Math.random()).not.toBe(0.5)',
          '})',
          '',
        ].join('\n'),
      }))
      const { result, view, stderr } = await runWithJson(project, pool)
      assert.equal(
        view.files.get('tests/a.test.js')?.tests.get('a leaves a spy on Math.random'),
        'passed',
        stderr,
      )
      assert.equal(
        view.files.get('tests/b.test.js')?.tests.get('b sees the real Math.random'),
        'passed',
        stderr,
      )
      assert.equal(result.exitCode, 0, stderr)
    })
  })
}
