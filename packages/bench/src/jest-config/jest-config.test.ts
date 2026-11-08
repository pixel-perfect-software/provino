// The pure parts of `bench:jest-config`: the 55 keys, gap 5's package-relative rule, the encoding,
// the sample's selection rules (F4) and T11.4's bar.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BAR_KEY_COUNT,
  compareReads,
  encode,
  GLOBAL_BAR_KEYS,
  PROJECT_BAR_KEYS,
  packageRelative,
  sameValue,
} from './compare.ts'
import { loadFailures } from './load.ts'
import {
  candidateFormat,
  emptyTally,
  hasJestObject,
  isExcludedPath,
  PER_REPO_CAP,
  quotasFull,
  SAMPLE_QUOTAS,
  SAMPLE_TOTAL,
  takeConfigs,
} from './sample-select.ts'

test('the bar is 55 keys: 46 project, 8 global, and preset', () => {
  assert.equal(PROJECT_BAR_KEYS.length, 46)
  assert.equal(GLOBAL_BAR_KEYS.length, 8)
  assert.equal(BAR_KEY_COUNT, 55)
  assert.equal(new Set([...PROJECT_BAR_KEYS, ...GLOBAL_BAR_KEYS]).size, 54)
})

test('gap 5: a path into one of the four packages compares package-relative; others exactly', () => {
  const packages = ['babel-jest', 'jest-environment-node', 'jest-circus', 'jest-runner']
  assert.equal(
    packageRelative(
      '/a/node_modules/.pnpm/babel-jest@30/node_modules/babel-jest/build/index.js',
      packages,
    ),
    'babel-jest/build/index.js',
  )
  assert.equal(
    packageRelative('/x/node_modules/jest-circus/runner.js', packages),
    'jest-circus/runner.js',
  )
  assert.equal(packageRelative('babel-jest', packages), 'babel-jest')
  assert.equal(
    packageRelative('/x/node_modules/ts-jest/dist/index.js', packages),
    '/x/node_modules/ts-jest/dist/index.js',
  )
})

test('compareReads: bar keys apart from the rest; the rule applies inside values', () => {
  const read = (transform: string, testTimeout: number, cwd: string) => ({
    projectConfig: encode({ transform: [['x', transform, {}]], testTimeout, cwd }) as Record<
      string,
      unknown
    >,
    globalConfig: encode({ seed: Math.random(), maxWorkers: 3 }) as Record<string, unknown>,
  })
  const same = compareReads(
    read('/a/node_modules/babel-jest/build/index.js', 5, '/w'),
    read('/b/node_modules/babel-jest/build/index.js', 5, '/w'),
  )
  assert.deepEqual(same, { bar: [], other: [] })
  const different = compareReads(read('/a/t.js', 5, '/w'), read('/b/t.js', 6, '/v'))
  assert.deepEqual(
    different.bar.map((d) => d.key),
    ['transform', 'testTimeout'],
  )
  assert.deepEqual(
    different.other.map((d) => d.key),
    ['cwd'],
  )
})

test('encode keeps what JSON drops', () => {
  assert.deepEqual(encode({ a: undefined, f: function named() {}, r: /x/g, n: Number.NaN }), {
    a: { $undefined: true },
    f: { $function: 'function named() {}' },
    r: { $regexp: 'x', flags: 'g' },
    n: { $number: 'NaN' },
  })
  assert.ok(sameValue(encode([1, { b: 2 }]), encode([1, { b: 2 }])))
  assert.ok(!sameValue(encode([1, { b: 2 }]), encode([1, { b: 3 }])))
})

test("F4's quotas add up to 299", () => {
  assert.equal(
    Object.values(SAMPLE_QUOTAS).reduce((sum, count) => sum + count, 0),
    SAMPLE_TOTAL,
  )
})

test("candidates: config names, package.json, and F4's exclusions", () => {
  assert.equal(candidateFormat('jest.config.js'), '.js')
  assert.equal(candidateFormat('packages/a/jest.config.cts'), '.cts')
  assert.equal(candidateFormat('jest.config.base.mjs'), '.mjs')
  assert.equal(candidateFormat('jest.unit.config.ts'), '.ts')
  assert.equal(candidateFormat('package.json'), 'package.json')
  assert.equal(candidateFormat('jest.setup.js'), undefined)
  assert.equal(candidateFormat('src/__fixtures__/jest.config.js'), undefined)
  assert.equal(candidateFormat('templates/app/jest.config.js'), undefined)
  assert.equal(candidateFormat('e2e/jest.config.js'), undefined)
  assert.equal(candidateFormat('node_modules/x/jest.config.js'), undefined)
  assert.ok(isExcludedPath('test/Fixtures/x'))
  assert.ok(hasJestObject('{"jest": {"a": 1}}'))
  assert.ok(!hasJestObject('{"jest": "./jest.js"}'))
  assert.ok(!hasJestObject('{"name": "x"}'))
})

test('takeConfigs: shallowest first, at most 6, quotas respected', () => {
  const tally = emptyTally()
  const paths = [
    'packages/z/jest.config.js',
    'jest.config.js',
    'packages/a/jest.config.js',
    'package.json',
    'packages/a/package.json',
    'b/jest.config.js',
    'c/jest.config.js',
    'd/jest.config.js',
    'e/jest.config.js',
  ]
  const taken = takeConfigs(paths, (path) => path === 'package.json', tally)
  assert.equal(taken.length, PER_REPO_CAP)
  assert.deepEqual(
    taken.map((t) => t.path),
    [
      'jest.config.js',
      'package.json',
      'b/jest.config.js',
      'c/jest.config.js',
      'd/jest.config.js',
      'e/jest.config.js',
    ],
  )
  tally['.js'] = SAMPLE_QUOTAS['.js']
  assert.deepEqual(
    takeConfigs(['x/jest.config.js'], () => false, tally),
    [],
  )
  assert.ok(!quotasFull(tally))
})

test("T11.4's bar: strictly under, on both medians, and NaN fails", () => {
  assert.deepEqual(loadFailures({ inProcessMs: 40, wallMs: 90 }, 150), [])
  assert.equal(loadFailures({ inProcessMs: 150, wallMs: 90 }, 150).length, 1)
  assert.equal(loadFailures({ inProcessMs: 40, wallMs: Number.NaN }, 150).length, 1)
  assert.deepEqual(loadFailures({ inProcessMs: 999, wallMs: 999 }, undefined), [])
})
