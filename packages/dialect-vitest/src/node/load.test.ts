// B25c: loading a config file: the `__dirname` and `__filename` Vite defines in a bundled config.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { findVitestConfig } from './find.ts'
import { loadVitestConfig } from './load.ts'
import { removeTrees, writeTree } from './test-support.ts'

after(removeTrees)

async function load(files: Record<string, string>, config: string) {
  const root = writeTree(files)
  const source = findVitestConfig(root, config)
  assert.ok(source)
  return { root, loaded: await loadVitestConfig(source, { mode: 'test' }) }
}

test('an ES module config may use __dirname and __filename, as Vite lets it', async () => {
  const { root, loaded } = await load(
    {
      'package.json': '{"type":"module"}',
      'vitest.config.ts':
        "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { name: __dirname + '|' + __filename } })\n",
    },
    'vitest.config.ts',
  )
  assert.deepEqual(loaded.config, { test: { name: `${root}|${root}/vitest.config.ts` } })
})

test('a config that declares them itself, or is CommonJS, is left alone', async () => {
  const declared = await load(
    {
      'package.json': '{"type":"module"}',
      'vitest.config.mjs':
        "import { dirname } from 'node:path'\nimport { fileURLToPath } from 'node:url'\nconst __dirname = dirname(fileURLToPath(import.meta.url))\nexport default { test: { name: __dirname } }\n",
    },
    'vitest.config.mjs',
  )
  assert.deepEqual(declared.loaded.config, { test: { name: declared.root } })
  const commonjs = await load(
    { 'vitest.config.cjs': 'module.exports = { test: { name: __dirname } }\n' },
    'vitest.config.cjs',
  )
  assert.deepEqual(commonjs.loaded.config, { test: { name: commonjs.root } })
})

test('a module the config imports gets them too', async () => {
  const { root, loaded } = await load(
    {
      'package.json': '{"type":"module"}',
      'shared/paths.ts': 'export const here = __dirname\n',
      'vitest.config.ts':
        "import { here } from './shared/paths.ts'\nexport default { test: { name: here } }\n",
    },
    'vitest.config.ts',
  )
  assert.deepEqual(loaded.config, { test: { name: `${root}/shared` } })
})

test("an import without an extension finds the file, or the directory's index, as the bundler does", async () => {
  const { loaded } = await load(
    {
      'package.json': '{"type":"module"}',
      'utils/index.ts': "export const a = 'index'\n",
      'shared.ts': "export const b = 'file'\n",
      'vitest.config.ts':
        "import { a } from './utils'\nimport { b } from './shared'\nexport default { test: { name: a + b } }\n",
    },
    'vitest.config.ts',
  )
  assert.deepEqual(loaded.config, { test: { name: 'indexfile' } })
})

test('a config function that throws, and one that gives no object, are coded errors', async () => {
  const thrown = await load(
    { 'vitest.config.mjs': 'export default () => { throw new Error("x") }\n' },
    'vitest.config.mjs',
  ).catch((error: unknown) => error)
  assert.equal((thrown as { code?: string }).code, 'VITEST_CONFIG_LOAD_FAILED')
  const bad = await load({ 'vitest.config.mjs': 'export default 3\n' }, 'vitest.config.mjs').catch(
    (error: unknown) => error,
  )
  assert.equal((bad as { code?: string }).code, 'VITEST_CONFIG_INVALID')
})

async function loadError(files: Record<string, string>, config: string): Promise<unknown> {
  return load(files, config).then(
    () => undefined,
    (error: unknown) => error,
  )
}

function causes(error: unknown): unknown[] {
  const out: unknown[] = []
  for (let at = error; at instanceof Error; at = at.cause) out.push(at)
  return out
}

test('a config function runs with the hooks and the stand-in still installed', async () => {
  const { loaded } = await load(
    {
      'package.json': '{"type":"module"}',
      'helper.ts': "export const label: string = 'from-helper'\n",
      'vitest.config.ts':
        "export default async () => {\n  const { defineConfig } = await import('vitest/config')\n  const { label } = await import('./helper')\n  return defineConfig({ test: { name: label } })\n}\n",
    },
    'vitest.config.ts',
  )
  assert.deepEqual(loaded.config, { test: { name: 'from-helper' } })
})

test('a require() of JSON from a CommonJS config gets the parsed value, not a namespace', async () => {
  const { loaded } = await load(
    {
      'list.json': '["a", "b"]\n',
      'vitest.config.cjs':
        "const list = require('./list.json')\nmodule.exports = { test: { name: Array.isArray(list) ? 'array' : 'namespace' } }\n",
    },
    'vitest.config.cjs',
  )
  assert.deepEqual(loaded.config, { test: { name: 'array' } })
})

test('CommonJS source is told from ES module source by its parse, not by its lines', async () => {
  const { loaded } = await load(
    {
      'package.json': '{"type":"commonjs"}',
      'vitest.config.js':
        "const text = `\nimport this from 'looks-like-an-import'\nexport const x = 1\n`\nPromise.resolve()\n  .then(() => 0)\nimport('node:path').catch(() => {})\nmodule.exports = { test: { name: String(text.length > 0) } }\n",
    },
    'vitest.config.js',
  )
  assert.deepEqual(loaded.config, { test: { name: 'true' } })
})

test('a file the parser rejects is left to Node, whose error is the one reported', async () => {
  const error = await loadError(
    { 'vitest.config.ts': 'export default { test: { name: \n' },
    'vitest.config.ts',
  )
  assert.equal((error as { code?: string }).code, 'VITEST_CONFIG_LOAD_FAILED')
  assert.ok(causes(error).some((entry) => entry instanceof SyntaxError))
})

test('a config that imports only defineConfig, mergeConfig and loadEnv from vite needs no Vite', async () => {
  const { loaded } = await load(
    {
      '.env': 'VITE_NAME=from-env\nOTHER=x\n',
      'package.json': '{"type":"module"}',
      'vite.config.ts':
        "import { defineConfig, loadEnv, mergeConfig, type UserConfig } from 'vite'\nconst env = loadEnv('test', __dirname, 'VITE_')\nconst base: UserConfig = { test: { name: env.VITE_NAME } }\nexport default defineConfig(mergeConfig(base, { test: { globals: true } }))\n",
    },
    'vite.config.ts',
  )
  assert.deepEqual(loaded.config, { test: { name: 'from-env', globals: true } })
})

test('any other export of vite loads the real package: not found here, a coded error', async () => {
  const error = await loadError(
    {
      'package.json': '{"type":"module"}',
      'vite.config.ts':
        "import { defineConfig, build } from 'vite'\nexport default defineConfig({ test: { name: typeof build } })\n",
    },
    'vite.config.ts',
  )
  assert.equal((error as { code?: string }).code, 'VITEST_CONFIG_LOAD_FAILED')
})

test('__dirname is defined where nothing declares it, and not where something does', async () => {
  const { root, loaded } = await load(
    {
      'package.json': '{"type":"module"}',
      'vitest.config.mjs':
        "const a = 1, __dirname = 'declared'\nexport default { test: { name: a + __dirname + typeof __filename } }\n",
      'other.mjs': '',
    },
    'vitest.config.mjs',
  )
  assert.deepEqual(loaded.config, { test: { name: '1declaredstring' } })
  const imported = await load(
    {
      'package.json': '{"type":"module"}',
      'dir.mjs': "export const __dirname = 'imported'\n",
      'vitest.config.mjs':
        "import { __dirname } from './dir.mjs'\nexport default { test: { name: __dirname } }\n",
    },
    'vitest.config.mjs',
  )
  assert.deepEqual(imported.loaded.config, { test: { name: 'imported' } })
  assert.ok(root.length > 0)
})
