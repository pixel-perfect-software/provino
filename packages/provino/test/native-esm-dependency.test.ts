// A native project whose test file imports an ES module package from node_modules (one Node loads
// itself) that imports a subpath of a package with no `exports` map (`other/sub`): Node's ES module
// resolution adds no extension, so the worker resolves it as `require` does. A package that has an
// `exports` map keeps Node's error. Through the source bin, on every pool.
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, POOLS, spawnCli } from './support.ts'

/** A CommonJS module that exports `value`. */
function exporting(value: string): string {
  return `exports.value = ${JSON.stringify(value)}\n`
}

/** The packages a dependency imports from: none of them has an `exports` map. */
const LEGACY_PACKAGES: Readonly<Record<string, string>> = {
  'node_modules/other/package.json': '{"name":"other","version":"1.0.0","main":"index.js"}\n',
  'node_modules/other/index.js': exporting('from other'),
  'node_modules/other/sub.js': exporting('from other/sub'),
  'node_modules/other/lib/index.js': exporting('from other/lib'),
  'node_modules/@scope/other/package.json': '{"name":"@scope/other","version":"1.0.0"}\n',
  'node_modules/@scope/other/sub.js': exporting('from @scope/other/sub'),
}

const LEGACY_PROJECT: Readonly<Record<string, string>> = {
  ...LEGACY_PACKAGES,
  'node_modules/esm-dep/package.json':
    '{"name":"esm-dep","type":"module","exports":"./index.js"}\n',
  'node_modules/esm-dep/index.js': [
    "import { value as file } from 'other/sub'",
    "import { value as directory } from 'other/lib'",
    "import { value as scoped } from '@scope/other/sub'",
    'export const got = { file, directory, scoped }',
    '',
  ].join('\n'),
  'tests/dep.test.ts': [
    "import { expect, test } from 'provino'",
    "import { got } from 'esm-dep'",
    "test('a file subpath resolves to its .js file', () => { expect(got.file).toBe('from other/sub') })",
    "test('a directory subpath resolves to its index.js', () => { expect(got.directory).toBe('from other/lib') })",
    "test('a scoped package subpath resolves', () => { expect(got.scoped).toBe('from @scope/other/sub') })",
    '',
  ].join('\n'),
}

const STRICT_PROJECT: Readonly<Record<string, string>> = {
  'node_modules/strict/package.json':
    '{"name":"strict","version":"1.0.0","exports":{".":"./index.js"}}\n',
  'node_modules/strict/index.js': exporting('from strict'),
  'node_modules/strict/sub.js': exporting('from strict/sub'),
  'node_modules/esm-strict/package.json':
    '{"name":"esm-strict","type":"module","exports":"./index.js"}\n',
  'node_modules/esm-strict/index.js': "export { value } from 'strict/sub'\n",
  'tests/dep.test.ts': [
    "import { expect, test } from 'provino'",
    "import { value } from 'esm-strict'",
    "test('never runs', () => { expect(value).toBe('from strict/sub') })",
    '',
  ].join('\n'),
}

describe('an ES module dependency importing a subpath of a package with no exports map', () => {
  for (const pool of POOLS) {
    test(`the file loads and its tests pass on the ${pool} pool`, async () => {
      const dir = await nativeProject(LEGACY_PROJECT)
      const ran = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      expect(ran.stderr).not.toMatch(/Cannot find module/)
      expect((await outcomesByFile(dir)).get('dep.test.ts')).toBe('passed,passed,passed')
      expect(ran.code).toBe(0)
    })
  }

  test('a package with an exports map that lacks the subpath still fails the file', async () => {
    const dir = await nativeProject(STRICT_PROJECT)
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect(ran.code).toBe(1)
    expect((await outcomesByFile(dir)).get('dep.test.ts')).toMatch(
      /strict.*\.\/sub|\.\/sub.*strict/s,
    )
  })
})
