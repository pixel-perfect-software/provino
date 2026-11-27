// T3.8 in the loader: `createProjectLoader` loads the project's own transformers by path, routes a
// file to the first transform whose pattern matches (and no ignore pattern does), keeps every
// other file on the Oxc path, and runs a transformer's CommonJS output as Jest runs it. A `require`
// of the runner's own module gets the per-module bindings (the stopgap until the facades, T11.10).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { neutralPolicy } from '@provino/policy'
import type { HoistPolicy, SerializedLoaderConfig, SerializedTransformConfig } from '@provino/types'
import { afterAll, test } from 'provino'
import { createProjectLoader } from './project.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-loader-transform-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

// Turns `.up` files into CommonJS that exports their upper-cased text, and records each call.
const UPPER = `
const calls = (globalThis.__transformCalls ??= [])
module.exports = {
  createTransformer: (options) => ({
    getCacheKey: () => 'key-' + options.tag,
    process: (source, path, o) => {
      calls.push({ path, tag: options.tag, esm: o.supportsStaticESM })
      return { code: 'module.exports = ' + JSON.stringify(source.toUpperCase()) }
    },
  }),
}
`

function config(
  root: string,
  transform: Partial<SerializedTransformConfig>,
  extra: Partial<SerializedLoaderConfig> = {},
): SerializedLoaderConfig {
  return {
    hoist: null,
    moduleScope: [],
    extensions: ['.ts', '.js', '.up', '.json'],
    conditions: ['node'],
    tsconfig: false,
    mappers: [],
    typescript: 'oxc',
    transform: {
      rules: [
        {
          pattern: '\\.up$',
          transformer: { module: join(root, 'upper.cjs'), export: 'default' },
          options: { tag: 'a' },
        },
      ],
      ignorePatterns: ['/skip/'],
      config: {},
      hoistedMarkers: [],
      ...transform,
    },
    ...extra,
  }
}

test('a file a transform matches goes through its transformer; every other file stays on Oxc', async () => {
  const root = writeTree({
    'upper.cjs': UPPER,
    'text.up': 'hello',
    'entry.test.ts': [
      "import text from './text.up'",
      'export const value: string = String(text)',
      '',
    ].join('\n'),
  })
  const loader = await createProjectLoader(root, config(root, {}), neutralPolicy.module)
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  const entry = await registry.import<{ value: string }>(join(root, 'entry.test.ts'))
  assert.equal(entry.value, 'HELLO')
  const calls = Reflect.get(globalThis, '__transformCalls') as { path: string; esm: boolean }[]
  assert.deepEqual(
    calls.filter((call) => call.path.startsWith(root)).map((call) => call.path),
    [join(root, 'text.up')],
  )
  // Jest's CommonJS path: no static ESM is offered.
  assert.equal(calls.at(-1)?.esm, false)
})

test('transformIgnorePatterns keep a file away from the transformer', async () => {
  const root = writeTree({
    'upper.cjs': UPPER,
    'skip/text.up': 'module.exports = "untouched"',
    'entry.test.ts': ["export const value: string = String(require('./skip/text.up'))", ''].join(
      '\n',
    ),
  })
  const loader = await createProjectLoader(root, config(root, {}), neutralPolicy.module)
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  // The ignored file takes the Oxc path, which has no route for `.up`: it fails to transform.
  await assert.rejects(registry.import(join(root, 'entry.test.ts')), /no transform handles/)
})

test('a transformer that cannot be loaded rejects the project loader, naming it', async () => {
  const root = writeTree({ 'entry.ts': 'export {}\n' })
  await assert.rejects(createProjectLoader(root, config(root, {}), neutralPolicy.module), {
    code: 'TRANSFORM_TRANSFORMER_LOAD_FAILED',
  })
})

test('a transformer that throws fails the file with its message', async () => {
  const root = writeTree({
    'upper.cjs': 'module.exports = { process: () => { throw new Error("cannot parse it") } }',
    'text.up': 'x',
    'entry.test.ts': ["import text from './text.up'", 'export const value = text', ''].join('\n'),
  })
  const loader = await createProjectLoader(root, config(root, {}), neutralPolicy.module)
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  await assert.rejects(registry.import(join(root, 'entry.test.ts')), /cannot parse it/)
})

test('a require of a served runner module gets the per-module value', async () => {
  const hoist = {
    id: 'test',
    objects: [],
    hoistCalls: {},
    hoistValues: [],
    rewriteImportArg: [],
    chainable: true,
    placement: 'enclosing-block',
    topLevelGuards: [],
    factoryReferences: 'allow',
    runnerModules: [],
    reExports: 'in-order',
    rewrittenCalls: 'detached',
    messages: {},
  } as unknown as HoistPolicy
  const root = writeTree({
    'entry.test.cjs': 'exports.same = require("@runner/globals").jest === jest\n',
  })
  const loader = await createProjectLoader(
    root,
    {
      hoist,
      moduleScope: ['jest'],
      scopeModules: ['@runner/globals'],
      extensions: ['.js', '.cjs'],
      conditions: ['node'],
      tsconfig: false,
      mappers: [],
      typescript: 'oxc',
    },
    neutralPolicy.module,
  )
  const mine = { name: 'mine' }
  const registry = loader.createFileRegistry(join(root, 'entry.test.cjs'), {
    tier: 'registry',
    moduleScope: () => ({ jest: mine, '@runner/globals': { jest: mine } }),
  })
  assert.equal(registry.require<{ same: boolean }>(join(root, 'entry.test.cjs')).same, true)
})

// What a Babel preset with JSX and Flow does for a React Native package, in two rules: `<b />`
// becomes `'b'`, and a `: number` or `: string` annotation goes. Each call is recorded.
const REACT_NATIVE_ISH = `
const calls = (globalThis.__strippedCalls ??= [])
module.exports = {
  createTransformer: () => ({
    process: (source, path) => {
      calls.push(path)
      return { code: source.replace(/<(\\w+) \\/>/g, "'$1'").replace(/: (?:number|string)\\b/g, '') }
    },
  }),
}
`

test('a claimed CommonJS node_modules file Node cannot parse (JSX, Flow) is transformed by the rule that takes it, per file', async () => {
  const root = writeTree({
    'strip.cjs': REACT_NATIVE_ISH,
    'node_modules/rn-like/package.json': JSON.stringify({ name: 'rn-like', main: 'index.js' }),
    'node_modules/rn-like/index.js':
      "'use strict'\nconst { half } = require('./half')\nconst h = (tag) => ({ tag })\nmodule.exports = { el: <b />, half, token: {} }\n",
    // Its own edge, reached through the registry, falls back the same way.
    'node_modules/rn-like/half.js':
      '// @flow\nfunction half(x: number): number {\n  return x / 2\n}\nexports.half = half\n',
    'node_modules/rn-plain/package.json': JSON.stringify({ name: 'rn-plain', main: 'index.js' }),
    'node_modules/rn-plain/index.js': 'exports.token = {}\n',
    'entry.test.ts':
      "import { el, half, token } from 'rn-like'\nimport { token as plain } from 'rn-plain'\nexport const values = { el, two: half(4), token, plain }\n",
  })
  const rule = {
    pattern: '\\.js$',
    transformer: { module: join(root, 'strip.cjs'), export: 'default' },
    options: {},
  }
  const loader = await createProjectLoader(
    root,
    config(
      root,
      { rules: [rule], ignorePatterns: [] },
      { transformClaims: { patterns: ['\\.js$'], ignorePatterns: [] } },
    ),
    { ...neutralPolicy.module, interopDefault: 'babel' },
  )
  type Values = { readonly el: string; two: number; token: object; plain: object }
  const run = async (): Promise<Values> => {
    const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
    return (await registry.import<{ values: Values }>(join(root, 'entry.test.ts'))).values
  }
  const first = await run()
  const second = await run()
  assert.equal(first.el, 'b', 'the JSX, through the rule')
  assert.equal(first.two, 2, 'the Flow annotations, through the rule')
  assert.notEqual(first.token, second.token, 'evaluated per file, as Jest does')
  assert.equal(
    first.plain,
    second.plain,
    'a claimed CommonJS file Node parses stays on the native path',
  )
  const calls = Reflect.get(globalThis, '__strippedCalls') as string[]
  assert.deepEqual(
    calls.filter((path) => path.startsWith(root)).toSorted(),
    [join(root, 'node_modules/rn-like/half.js'), join(root, 'node_modules/rn-like/index.js')],
    'each transformed once per worker; the native one never',
  )
})

// Under `assetImports: 'built-in'` the loader makes the module of an asset or style file, unless a
// transform the project configured takes it.
test('a configured transform for .svg wins over the built-in asset module', async () => {
  const root = writeTree({
    'upper.cjs': UPPER,
    'logo.svg': 'inline svg',
    'other.svg': '<svg/>',
    'entry.test.ts': [
      "import logo from './logo.svg'",
      "import other from './other.svg'",
      'export const value = [String(logo), String(other)]',
      '',
    ].join('\n'),
  })
  const loader = await createProjectLoader(
    root,
    config(root, {
      rules: [
        {
          pattern: 'logo\\.svg$',
          transformer: { module: join(root, 'upper.cjs'), export: 'default' },
          options: { tag: 'svg' },
        },
      ],
    }),
    { ...neutralPolicy.module, assetImports: 'built-in' },
  )
  const registry = loader.createFileRegistry(join(root, 'entry.test.ts'), { tier: 'registry' })
  const entry = await registry.import<{ value: string[] }>(join(root, 'entry.test.ts'))
  assert.deepEqual(entry.value, ['INLINE SVG', '/other.svg'])
})
