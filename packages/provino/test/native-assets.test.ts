// A native project imports an asset or style file as a module the loader makes itself
// (`ModulePolicy.assetImports`): `./logo.svg` is its URL as Vite's dev server writes it, a style file
// is empty, a CSS module answers each name with itself, and a mock still wins. A project on the
// Jest dialect keeps the failure. Through the source bin.
import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'provino'
import { nativeProject, nativeRunArgs, outcomesByFile, spawnCli, whenFileEnds } from './support.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>\n'

/** A directory outside the project's root, with one asset in it. */
function outsideDirectory(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-assets-outside-')))
  whenFileEnds(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('importing an asset or a style file in a native project', () => {
  test('each kind of file imports as what the loader makes of it', async () => {
    const outside = outsideDirectory()
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
      [`../${outside.split('/').at(-1)}/outside.png`]: 'x',
      'tests/assets.test.ts': [
        "import { expect, mock, test } from 'provino'",
        "import logo from '../logo.svg'",
        "import nested from '../src/a/b.png'",
        "import css from '../src/app.css'",
        "import scss from '../src/theme.scss'",
        "import styles from '../src/card.module.css'",
        "import mocked from '../src/mocked.svg'",
        `import outside from ${JSON.stringify(join(outside, 'outside.png'))}`,
        "import required from '../src/cjs.test-helper.cjs'",
        "mock('../src/mocked.svg', () => ({ default: 'mocked-url' }))",
        "test('an svg is its URL', () => { expect(typeof logo).toBe('string'); expect(logo).toBe('/logo.svg') })",
        "test('a nested asset keeps its path', () => { expect(nested).toBe('/src/a/b.png') })",
        `test('an asset outside the root is under /@fs', () => { expect(outside).toBe('/@fs' + ${JSON.stringify(join(outside, 'outside.png'))}) })`,
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
