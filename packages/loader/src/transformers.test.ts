// T3.8 in the loader: `createProjectLoader` loads the project's own transformers by path, routes a
// file to the first transform whose pattern matches (and no ignore pattern does), keeps every
// other file on the Oxc path, and runs a transformer's CommonJS output as Jest runs it. A `require`
// of the runner's own module gets the per-module bindings (the stopgap until the facades, T11.10).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import type { HoistPolicy, SerializedLoaderConfig, SerializedTransformConfig } from '@provino/types'
import { createProjectLoader } from './project.ts'

const roots: string[] = []
after(() => {
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
