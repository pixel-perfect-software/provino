import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { parseCli } from '../cli-args.ts'
import { BenchError } from '../errors.ts'
import { tsCorpusFiles } from '../generators/ts-corpus.ts'
import { DEFAULT_WORK_DIR, parseLegs } from './command.ts'
import { LEGS } from './legs.ts'
import { importsOf } from './prepare.ts'

const isUsage = (error: unknown): boolean =>
  error instanceof BenchError && error.code === 'BENCH_USAGE'

test('instructions: every leg once, cachegrind on, one count and five wall runs by default', () => {
  const command = parseCli(['instructions'])
  assert.equal(command.command, 'instructions')
  if (command.command !== 'instructions') return
  assert.deepEqual(command.legs, LEGS)
  assert.equal(command.runs, 1)
  assert.equal(command.wallRuns, 5)
  assert.equal(command.cachegrind, true)
  assert.equal(command.plant, false)
  assert.equal(command.signals, true)
  assert.equal(command.build, true)
  assert.equal(command.workDir, DEFAULT_WORK_DIR)
  assert.equal(command.baseline, undefined)
})

test('instructions: every option', () => {
  const command = parseCli([
    'instructions',
    '--legs',
    'core, app-50,core',
    '--baseline',
    'main.json',
    '--out',
    'pr.json',
    '--runs',
    '3',
    '--wall-runs',
    '2',
    '--plant',
    '--no-signals',
    '--no-build',
    '--sha',
    '0123abc',
    '--work-dir',
    '/w',
    '--summary-file',
    '/s.md',
  ])
  assert.equal(command.command, 'instructions')
  if (command.command !== 'instructions') return
  assert.deepEqual(
    command.legs.map((leg) => leg.id),
    ['core', 'app-50'],
  )
  assert.equal(command.baseline, 'main.json')
  assert.equal(command.out, 'pr.json')
  assert.equal(command.runs, 3)
  assert.equal(command.wallRuns, 2)
  assert.equal(command.plant, true)
  assert.equal(command.signals, false)
  assert.equal(command.build, false)
  assert.equal(command.sha, '0123abc')
  assert.equal(command.workDir, '/w')
  assert.equal(command.summaryFile, '/s.md')
  const plain = parseCli(['instructions', '--no-cachegrind'])
  assert.equal(plain.command === 'instructions' && plain.cachegrind, false)
})

test('instructions: usage errors', () => {
  for (const argv of [
    ['instructions', 'app-50'],
    ['instructions', '--legs', 'app-500'],
    ['instructions', '--legs', ','],
    ['instructions', '--runs', '0'],
    ['instructions', '--sha', 'main'],
    ['instructions', '--label', 'pinned'],
    ['instructions', '--baseline', ' '],
    // A plant needs a T12.13 suite to plant in: any other legs would run no self-test and pass.
    ['instructions', '--plant', '--legs', 'core'],
    ['instructions', '--plant', '--legs', 'transform,loader-e2e'],
  ]) {
    assert.throws(() => parseCli(argv), isUsage, argv.join(' '))
  }
  assert.throws(() => parseLegs('core,warm,nope'), /unknown leg "nope"/)
})

test('instructions: --plant with a suite leg among the legs is accepted', () => {
  const command = parseCli(['instructions', '--plant', '--legs', 'core,isolate-heavy'])
  assert.equal(command.command === 'instructions' && command.plant, true)
})

test('instructions: a relative --work-dir is made absolute once, for the parent and every child', () => {
  const command = parseCli(['instructions', '--work-dir', 'some/dir'])
  assert.equal(command.command === 'instructions' && command.workDir, resolve('some/dir'))
})

test('the TS corpus is the same every time, and its imports are what the resolve leg asks', () => {
  const first = tsCorpusFiles()
  assert.deepEqual(tsCorpusFiles(), first)
  assert.equal(first.length, 120)
  const sizes = first.map((file) => file.contents.length)
  assert.ok(Math.min(...sizes) > 1500, 'every file is a few KB of code')
  const imports = first.flatMap((file) => importsOf(file.contents))
  assert.ok(imports.some((specifier) => /^\.\/m\d{3}\.ts$/.test(specifier)))
  assert.ok(imports.some((specifier) => /^\.\/m\d{3}$/.test(specifier)))
  assert.ok(imports.some((specifier) => ['date-fns', 'lodash', 'zod'].includes(specifier)))
  assert.ok(imports.some((specifier) => specifier.startsWith('node:')))
  assert.deepEqual(
    importsOf("import { a } from './x'\nimport type { B } from 'y'\nconst z = 1\n"),
    ['./x', 'y'],
  )
})
