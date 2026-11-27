// Native `stubGlobal` and `stubEnv` (the engine's stubs over the file's mock registry): a global
// node lacks (`location`) and an accessor global (`navigator`) stand in for one test, an environment
// variable is set and deleted, and the next test sees every original again. Through the source bin
// on every pool.
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, POOLS, spawnCli } from './support.ts'

const PROJECT: Readonly<Record<string, string>> = {
  'tests/stubs.test.ts': [
    "import { expect, stubEnv, stubGlobal, test, unstubAllGlobals } from 'provino'",
    'const g = globalThis as Record<string, unknown>',
    'const before = Object.getOwnPropertyDescriptor(globalThis, "navigator")',
    'process.env.PROVINO_STUBBED_SET = "original"',
    'delete process.env.PROVINO_STUBBED_NEW',
    "test('a global node lacks stands in', () => {",
    "  expect('location' in g).toBe(false)",
    "  stubGlobal('location', { search: '?a' })",
    "  expect((g.location as { search: string }).search).toBe('?a')",
    '})',
    "test('the missing global is gone again', () => {",
    "  expect('location' in g).toBe(false)",
    '})',
    "test('an accessor global stands in', () => {",
    "  stubGlobal('navigator', { userAgent: 'x' })",
    "  expect(navigator.userAgent).toBe('x')",
    '})',
    "test('the accessor is back as it was', () => {",
    "  expect(Object.getOwnPropertyDescriptor(globalThis, 'navigator')).toEqual(before)",
    '})',
    "test('an environment variable is set and deleted', () => {",
    "  stubEnv('PROVINO_STUBBED_SET', 'changed')",
    "  stubEnv('PROVINO_STUBBED_NEW', 'made')",
    "  expect(process.env.PROVINO_STUBBED_SET).toBe('changed')",
    "  expect(process.env.PROVINO_STUBBED_NEW).toBe('made')",
    "  stubEnv('PROVINO_STUBBED_SET', undefined)",
    "  expect('PROVINO_STUBBED_SET' in process.env).toBe(false)",
    '})',
    "test('the variables are back', () => {",
    "  expect(process.env.PROVINO_STUBBED_SET).toBe('original')",
    "  expect('PROVINO_STUBBED_NEW' in process.env).toBe(false)",
    '})',
    "test('unstubAllGlobals puts a global back inside the test', () => {",
    "  stubGlobal('location', { search: '?b' })",
    '  unstubAllGlobals()',
    "  expect('location' in g).toBe(false)",
    '})',
    '',
  ].join('\n'),
}

describe('stubGlobal and stubEnv in a native project', () => {
  for (const pool of POOLS) {
    test(`each stand-in lasts one test on the ${pool} pool`, async () => {
      const dir = await nativeProject(PROJECT)
      const ran = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      expect((await outcomesByFile(dir)).get('stubs.test.ts')).toBe(
        'passed,passed,passed,passed,passed,passed,passed',
      )
      expect(ran.code).toBe(0)
    })
  }
})
