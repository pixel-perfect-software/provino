// The coordinator's half of the worker's map interning: counters-only takes get their maps back.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IstanbulFileCoverageData } from '@provino/types'
import { expandIstanbulData, type KnownMaps } from './expand.ts'

const at = { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }
function data(hits: number): IstanbulFileCoverageData {
  return {
    path: '/p/a.ts',
    statementMap: { '0': at },
    fnMap: { '0': { name: 'f', decl: at, loc: at } },
    branchMap: { '0': { type: 'if', locations: [at, at] } },
    s: { '0': hits },
    f: { '0': hits },
    b: { '0': [hits, 0] },
    hash: 'h1',
  }
}

test('a take that came without maps gets them back from the first that had them', () => {
  const known: KnownMaps = new Map()
  const first = expandIstanbulData(known, { '/p/a.ts': data(3) })
  assert.deepEqual(first['/p/a.ts'], data(3))
  const counters = { path: '/p/a.ts', hash: 'h1', s: { '0': 2 }, f: { '0': 2 }, b: { '0': [2, 0] } }
  assert.deepEqual(expandIstanbulData(known, { '/p/a.ts': counters })['/p/a.ts'], data(2))
})

test('counters whose maps never came are COVERAGE_BAD_DATA', () => {
  assert.throws(
    () => expandIstanbulData(new Map(), { '/p/a.ts': { path: '/p/a.ts', s: {}, f: {}, b: {} } }),
    { code: 'COVERAGE_BAD_DATA' },
  )
})
