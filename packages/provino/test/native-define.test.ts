// A native project's `define` key (#210): compile-time replacement in the modules the pipeline
// transforms, as a bundler's define does, so a Vite app's `import.meta.env` reads work without the
// runner emulating Vite. Through the source bin, on every pool.
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, POOLS, spawnCli } from './support.ts'

const FILES: Readonly<Record<string, string>> = {
  'src/app.ts': [
    'export const dev: boolean = import.meta.env.DEV',
    'export const mode: string = import.meta.env.MODE',
    'export const version = __APP_VERSION__',
    'export const all = import.meta.env',
    '',
  ].join('\n'),
  'tests/app.test.ts': [
    "import { expect, test } from 'provino'",
    "import { all, dev, mode, version } from '../src/app.ts'",
    "test('a module reads the defined values', () => {",
    '  expect(dev).toBe(true)',
    "  expect(mode).toBe('test')",
    "  expect(version).toBe('1.2.3')",
    '})',
    '',
  ].join('\n'),
}

const CONFIG = [
  'export default {',
  "  include: ['tests/**/*.test.ts'],",
  '  define: {',
  "    'import.meta.env.DEV': true,",
  "    'import.meta.env.MODE': '\"test\"',",
  '    __APP_VERSION__: \'"1.2.3"\',',
  "    'import.meta.env': { DEV: true },",
  '  },',
  '}',
  '',
].join('\n')

describe('the define config key', () => {
  for (const pool of POOLS) {
    test(`a module reads what define replaces on the ${pool} pool`, async () => {
      const dir = await nativeProject(FILES, CONFIG)
      const ran = await spawnCli(nativeRunArgs(pool), { cwd: dir })
      expect(ran.stderr).not.toMatch(/Cannot read properties of undefined/)
      expect((await outcomesByFile(dir)).get('app.test.ts')).toBe('passed')
      expect(ran.code).toBe(0)
    })
  }

  test('without define the module throws as it loads', async () => {
    const dir = await nativeProject(FILES)
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect(ran.code).toBe(1)
    expect((await outcomesByFile(dir)).get('app.test.ts')).toMatch(
      /Cannot read properties of undefined \(reading 'DEV'\)/,
    )
  })
})
