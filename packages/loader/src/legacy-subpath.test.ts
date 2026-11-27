// The worker's fallback for a shared external's own imports: a bare import of a subpath into a
// package with no `exports` map resolves as `require` would. `legacySubpathTarget` is the decision,
// over temp trees; the installed hook is process-wide, so it runs in a child process only.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'provino'
import { legacySubpathTarget } from './legacy-subpath.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-legacy-subpath-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const CJS = 'exports.value = 1\n'

/** Packages with no `exports` map, one with, and the ES module dependency that imports them. */
const TREE: Readonly<Record<string, string>> = {
  'node_modules/legacy/package.json': '{"name":"legacy","main":"index.js"}\n',
  'node_modules/legacy/index.js': CJS,
  'node_modules/legacy/sub.js': CJS,
  'node_modules/legacy/lib/index.js': CJS,
  'node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg"}\n',
  'node_modules/@scope/pkg/sub.js': CJS,
  'node_modules/strict/package.json': '{"name":"strict","exports":{".":"./index.js"}}\n',
  'node_modules/strict/index.js': CJS,
  'node_modules/strict/sub.js': CJS,
  'node_modules/esm-dep/package.json':
    '{"name":"esm-dep","type":"module","exports":"./index.js"}\n',
  'node_modules/esm-dep/index.js': "import { value } from 'legacy/sub'\nexport { value }\n",
  'app/main.js': '',
}

const NOT_FOUND = Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
const DIRECTORY = Object.assign(new Error('directory'), { code: 'ERR_UNSUPPORTED_DIR_IMPORT' })

describe('legacySubpathTarget', () => {
  let root = ''
  let importer = ''
  beforeAll(() => {
    root = writeTree(TREE)
    importer = pathToFileURL(join(root, 'node_modules/esm-dep/index.js')).href
  })
  const urlOf = (path: string): string => pathToFileURL(join(root, path)).href

  it('resolves a file subpath of a package with no exports map to its .js file', () => {
    expect(legacySubpathTarget('legacy/sub', importer, NOT_FOUND)).toBe(
      urlOf('node_modules/legacy/sub.js'),
    )
  })

  it('resolves a directory subpath to its index.js', () => {
    expect(legacySubpathTarget('legacy/lib', importer, DIRECTORY)).toBe(
      urlOf('node_modules/legacy/lib/index.js'),
    )
  })

  it('resolves a subpath of a scoped package', () => {
    expect(legacySubpathTarget('@scope/pkg/sub', importer, NOT_FOUND)).toBe(
      urlOf('node_modules/@scope/pkg/sub.js'),
    )
  })

  it('leaves a package with an exports map to the error Node threw', () => {
    expect(legacySubpathTarget('strict/sub', importer, NOT_FOUND)).toBeUndefined()
  })

  it('leaves an importer outside node_modules to the error Node threw', () => {
    const app = pathToFileURL(join(root, 'app/main.js')).href
    expect(legacySubpathTarget('legacy/sub', app, NOT_FOUND)).toBeUndefined()
  })

  it.each([
    ['a relative specifier', './sub'],
    ['a node: specifier', 'node:fs/promises'],
    ['a bare package name with no subpath', 'legacy'],
  ])('has no answer for %s', (_name, specifier) => {
    expect(legacySubpathTarget(specifier, importer, NOT_FOUND)).toBeUndefined()
  })

  it('has no answer for an error that is not a missing file', () => {
    const other = Object.assign(new Error('not exported'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    })
    expect(legacySubpathTarget('legacy/sub', importer, other)).toBeUndefined()
    expect(legacySubpathTarget('legacy/sub', importer, new Error('no code'))).toBeUndefined()
  })

  it('has no answer for a package that is not installed or a subpath require cannot find', () => {
    expect(legacySubpathTarget('absent/sub', importer, NOT_FOUND)).toBeUndefined()
    expect(legacySubpathTarget('legacy/missing', importer, NOT_FOUND)).toBeUndefined()
  })
})

/** What the child prints: how each of three fresh trees loaded the ES module dependency. */
interface Observed {
  readonly before: string
  readonly after: { readonly viaImport: unknown; readonly viaRequire: unknown }
  readonly removed: string
}

describe('installLegacySubpathFallback', () => {
  it('lets a shared external import a subpath, and its returned call removes the hook', () => {
    const [before, after, removed] = [writeTree(TREE), writeTree(TREE), writeTree(TREE)]
    const scratch = writeTree({})
    const module = pathToFileURL(join(import.meta.dirname, 'legacy-subpath.ts')).href
    const entry = join(scratch, 'entry.mjs')
    writeFileSync(
      entry,
      [
        "import { createRequire } from 'node:module'",
        "import { join } from 'node:path'",
        "import { pathToFileURL } from 'node:url'",
        `import { installLegacySubpathFallback } from ${JSON.stringify(module)}`,
        'const [before, after, removed] = process.argv.slice(2)',
        "const dep = (root) => join(root, 'node_modules/esm-dep/index.js')",
        'const code = (error) => error?.code ?? String(error)',
        'const observed = {}',
        "try { await import(pathToFileURL(dep(before)).href); observed.before = 'loaded' } catch (error) { observed.before = code(error) }",
        'const uninstall = installLegacySubpathFallback()',
        'const viaImport = (await import(pathToFileURL(dep(after)).href)).value',
        "const viaRequire = createRequire(join(after, 'x.js'))(dep(after)).value",
        'observed.after = { viaImport, viaRequire }',
        'uninstall()',
        "try { await import(pathToFileURL(dep(removed)).href); observed.removed = 'loaded' } catch (error) { observed.removed = code(error) }",
        'console.log(JSON.stringify(observed))',
        '',
      ].join('\n'),
    )
    const ran = spawnSync(
      process.execPath,
      ['--conditions=provino-source', entry, before, after, removed],
      { encoding: 'utf8' },
    )
    expect(ran.status === 0 ? 'exited 0' : ran.stderr).toBe('exited 0')
    const observed = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '') as Observed
    expect(observed).toEqual({
      before: 'ERR_MODULE_NOT_FOUND',
      after: { viaImport: 1, viaRequire: 1 },
      removed: 'ERR_MODULE_NOT_FOUND',
    })
  })
})
