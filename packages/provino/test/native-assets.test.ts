// A native project imports an asset or style file as a module the loader makes itself
// (`ModulePolicy.assetImports`): `./logo.svg` is its URL as Vite's dev server writes it, a style file
// is empty, a CSS module answers each name with itself, and a mock still wins. A project on the
// Jest dialect keeps the failure. Through the source bin.
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, scratch, spawnCli } from './support.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>\n'

describe('importing an asset or a style file in a native project', () => {
  test('each kind of file imports as what the loader makes of it', async () => {
    const outside = scratch('provino-assets-outside-')
    const outsideFile = join(outside, 'outside.png')
    writeFileSync(outsideFile, 'x')
    const outsidePath = JSON.stringify(outsideFile)
    const dir = await nativeProject({
      'logo.svg': SVG,
      'src/a/b.png': 'not a png',
      'src/app.css': 'body { color: red }\n',
      'src/theme.scss': '$a: 1;\n',
      'src/card.module.css': '.foo { color: red }\n',
      'src/mocked.svg': SVG,
      'src/cjs.test-helper.cjs':
        "module.exports = { asset: require('./a/b.png'), plain: require('./plain.mjs') }\n",
      'src/plain.mjs': "export default '/src/a/b.png'\n",
      'tests/assets.test.ts': [
        "import { expect, mock, test } from 'provino'",
        "import logo from '../logo.svg'",
        "import nested from '../src/a/b.png'",
        "import css from '../src/app.css'",
        "import scss from '../src/theme.scss'",
        "import styles from '../src/card.module.css'",
        "import mocked from '../src/mocked.svg'",
        `import outside from ${outsidePath}`,
        "import required from '../src/cjs.test-helper.cjs'",
        "mock('../src/mocked.svg', () => ({ default: 'mocked-url' }))",
        "test('an svg is its URL', () => { expect(typeof logo).toBe('string'); expect(logo).toBe('/logo.svg') })",
        "test('a nested asset keeps its path', () => { expect(nested).toBe('/src/a/b.png') })",
        `test('an asset outside the root is under /@fs', () => { expect(outside).toBe('/@fs' + ${outsidePath}) })`,
        "test('a style file is empty', () => { expect(css).toBe(''); expect(scss).toBe('') })",
        "test('a CSS module answers each name with itself', () => {",
        "  expect(styles.foo).toBe('foo')",
        "  expect(styles.anything).toBe('anything')",
        '  expect(styles.then).toBe(undefined)',
        '  expect((styles as Record<string, unknown>).__esModule).toBe(undefined)',
        '  expect(Object.getPrototypeOf(styles)).toBe(null)',
        '})',
        "test('a mock still wins', () => { expect(mocked).toBe('mocked-url') })",
        "test('require sees the module as an import does', () => {",
        '  const both = required as { asset: unknown; plain: unknown }',
        '  expect(both.asset).toEqual(both.plain)',
        "  expect(JSON.stringify(both.asset)).toContain('/src/a/b.png')",
        '})',
        '',
      ].join('\n'),
    })
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect(ran.stderr).not.toMatch(/no transform handles/)
    expect((await outcomesByFile(dir)).get('assets.test.ts')).toBe(
      'passed,passed,passed,passed,passed,passed,passed',
    )
    expect(ran.code).toBe(0)
  })

  test("a dependency's asset and style file import as modules too", async () => {
    const dir = await nativeProject({
      'node_modules/ui-lib/package.json': '{"name":"ui-lib","version":"1.0.0"}\n',
      'node_modules/ui-lib/dist/style.css': '.a { color: red }\n',
      'node_modules/ui-lib/logo.svg': SVG,
      'tests/dep.test.ts': [
        "import { expect, test } from 'provino'",
        "import sheet from 'ui-lib/dist/style.css'",
        "import logo from 'ui-lib/logo.svg'",
        "test('a dependency stylesheet is empty', () => { expect(sheet).toBe('') })",
        "test('a dependency asset is its URL', () => { expect(logo).toBe('/node_modules/ui-lib/logo.svg') })",
        '',
      ].join('\n'),
    })
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect((await outcomesByFile(dir)).get('dep.test.ts')).toBe('passed,passed')
    expect(ran.code).toBe(0)
  })

  test('?raw is the text, ?url the URL, and any other query is as none', async () => {
    const dir = await nativeProject({
      'src/a.svg': SVG,
      'src/a.css': 'body { color: red }\n',
      'tests/query.test.ts': [
        "import { expect, test } from 'provino'",
        "import rawSvg from '../src/a.svg?raw'",
        "import rawCss from '../src/a.css?raw'",
        "import urlCss from '../src/a.css?url'",
        "import plain from '../src/a.svg?v=2'",
        "import both from '../src/a.svg?x=1&raw'",
        "test('raw is the text', () => {",
        '  expect(rawSvg).toBe(' + JSON.stringify(SVG) + ')',
        "  expect(rawCss).toBe('body { color: red }\\n')",
        '  expect(both).toBe(rawSvg)',
        '})',
        "test('url is the URL, even for a style file', () => { expect(urlCss).toBe('/src/a.css') })",
        "test('another query is as none', () => { expect(plain).toBe('/src/a.svg') })",
        '',
      ].join('\n'),
    })
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect((await outcomesByFile(dir)).get('query.test.ts')).toBe('passed,passed,passed')
    expect(ran.code).toBe(0)
  })

  for (const provider of ['v8', 'istanbul'] as const) {
    test('the assets are in no coverage report (' + provider + ')', async () => {
      const dir = await nativeProject(
        {
          'src/logo.svg': SVG,
          'src/app.css': 'body { color: red }\n',
          'src/a.ts': 'export const a = (n: number): number => n + 1\n',
          'tests/cov.test.ts': [
            "import { expect, test } from 'provino'",
            "import logo from '../src/logo.svg'",
            "import css from '../src/app.css'",
            "import { a } from '../src/a.ts'",
            "test('loads both', () => { expect(logo).toBe('/src/logo.svg'); expect(css).toBe(''); expect(a(1)).toBe(2) })",
            '',
          ].join('\n'),
        },
        'export default ' +
          JSON.stringify({
            include: ['tests/**/*.test.ts'],
            coverage: { provider, include: ['src/**'], reporters: ['lcovonly'] },
          }) +
          '\n',
      )
      const ran = await spawnCli([...nativeRunArgs('forks'), '--coverage'], { cwd: dir })
      expect(ran.code).toBe(0)
      expect((await outcomesByFile(dir)).get('cov.test.ts')).toBe('passed')
      const report = join(dir, 'coverage', 'lcov.info')
      expect(existsSync(report)).toBe(true)
      const files = (await readFile(report, 'utf8')).split('\n').filter((l) => l.startsWith('SF:'))
      expect(files.some((l) => l.endsWith('src/a.ts'))).toBe(true)
      expect(files.filter((l) => /\.(?:svg|css)$/.test(l))).toEqual([])
    })
  }

  test('a project on the Jest dialect still fails the file', async () => {
    const dir = await nativeProject(
      {
        'logo.svg': SVG,
        'tests/asset.test.ts': [
          "import logo from '../logo.svg'",
          "test('never runs', () => { expect(typeof logo).toBe('string') })",
          '',
        ].join('\n'),
      },
      "export default { dialect: 'jest', include: ['tests/**/*.test.ts'] }\n",
    )
    const ran = await spawnCli(nativeRunArgs('forks'), { cwd: dir })
    expect(ran.code).toBe(1)
    expect((await outcomesByFile(dir)).get('asset.test.ts')).toMatch(/no transform handles/)
  })
})
