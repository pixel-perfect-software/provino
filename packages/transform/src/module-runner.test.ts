import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TransformRecord } from '@provino/types'
import { toModuleRunner } from './module-runner.ts'
import { createPipeline } from './pipeline.ts'

const pipeline = createPipeline({
  root: '/',
  typescript: 'oxc',
  tsconfig: false,
  hoist: null,
  cache: false,
})

function strip(filename: string, source: string): TransformRecord {
  return pipeline.transform({
    filename,
    source,
    role: 'source',
    consumer: 'import',
    instrument: false,
  })
}

test('stripped TypeScript becomes module-runner form, with deps and a composed map', () => {
  const source = [
    "import type { T } from './types.js'",
    "export type { T } from './types.js'",
    "import { value } from './dep.js'",
    'export const doubled: T = value * 2',
    "export const later = () => import('./lazy.js')",
    '',
  ].join('\n')
  const output = toModuleRunner('/m.ts', strip('/m.ts', source))
  assert.match(output.code, /__vite_ssr_import__\("\.\/dep\.js"/)
  assert.match(output.code, /__vite_ssr_dynamic_import__\("\.\/lazy\.js"\)/)
  assert.doesNotMatch(output.code, /types\.js/, 'type-only imports and exports are gone')
  assert.deepEqual(output.deps, ['./dep.js'])
  assert.deepEqual(output.dynamicDeps, ['./lazy.js'])
  assert.deepEqual(output.map?.sources, ['/m.ts'], 'the map leads back to the original file')
})

test('a failure is a per-file TransformError that names the file', () => {
  const broken: TransformRecord = { ...strip('/ok.ts', 'export {}\n'), code: 'export const = 1\n' }
  assert.throws(
    () => toModuleRunner('/broken.ts', broken),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'TRANSFORM_RUNNER_FAILED')
      assert.match(String(error), /\/broken\.ts/)
      return true
    },
  )
})
