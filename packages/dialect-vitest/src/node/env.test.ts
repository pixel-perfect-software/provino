// B25c: `parseDotenv`, `expandDotenv` and `loadVitestEnv` against Vite's `loadEnv`, which the
// project's Vitest brings in (reached through it: Vite is no dependency of ours, D172).
import assert from 'node:assert/strict'
import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, test } from 'provino'
import { loadVitestEnv, parseDotenv } from './env.ts'
import { removeTrees, writeTree } from './test-support.ts'

afterAll(removeTrees)

type LoadEnv = (
  mode: string,
  envDir: string,
  prefixes?: string | string[],
) => Record<string, string>

async function viteLoadEnv(): Promise<LoadEnv> {
  const manifest = findPackageJSON('vite', import.meta.resolve('vitest'))
  assert.ok(manifest, 'vite is reachable through vitest')
  const module: unknown = await import(
    pathToFileURL(join(dirname(manifest), 'dist/node/index.js')).href
  )
  const loadEnv = Reflect.get(module as object, 'loadEnv')
  assert.equal(typeof loadEnv, 'function')
  return loadEnv as LoadEnv
}

const FILES: Readonly<Record<string, string>> = {
  '.env': [
    'VITE_A=base',
    'VITE_B="quoted value"',
    "VITE_C='single'",
    'VITE_D=`back`',
    'VITE_E=has # comment',
    'VITE_F="line1\\nline2"',
    'SECRET=nope',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv syntax, not a template
    'VITE_REF=${VITE_A}-ref',
    'VITE_BARE=$VITE_A/bare',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: dotenv syntax, not a template
    'VITE_DEFAULT=${MISSING_ONE:-fallback}',
    'VITE_ESCAPED=\\$VITE_A',
    'export VITE_EXPORTED=yes',
    '# VITE_COMMENTED=no',
    'VITE_EMPTY=',
    '',
  ].join('\n'),
  '.env.local': 'VITE_A=local\nVITE_ONLY_LOCAL=1\n',
  '.env.test': 'VITE_B=test-mode\nVITE_MODE_ONLY=t\n',
  '.env.test.local': 'VITE_MODE_ONLY=tl\n',
  '.env.production': 'VITE_A=prod\n',
}

test('loadVitestEnv equals Vite loadEnv over the .env files of a mode', async () => {
  const loadEnv = await viteLoadEnv()
  const dir = writeTree(FILES)
  for (const mode of ['test', 'production', 'staging']) {
    assert.deepEqual(
      loadVitestEnv({ mode, envDir: dir, prefixes: ['VITE_'], processEnv: {} }),
      loadEnv(mode, dir, 'VITE_'),
      mode,
    )
  }
})

test('a prefix list and the process environment are read as Vite reads them', async () => {
  const loadEnv = await viteLoadEnv()
  const dir = writeTree(FILES)
  const before = { ...process.env }
  process.env.VITE_FROM_PROCESS = 'p'
  process.env.PUBLIC_X = 'x'
  try {
    assert.deepEqual(
      loadVitestEnv({
        mode: 'test',
        envDir: dir,
        prefixes: ['VITE_', 'PUBLIC_', 'SECRET'],
        processEnv: process.env,
      }),
      loadEnv('test', dir, ['VITE_', 'PUBLIC_', 'SECRET']),
    )
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
  }
})

test('a missing directory or file gives nothing', () => {
  assert.deepEqual(
    loadVitestEnv({
      mode: 'test',
      envDir: '/nonexistent-dir',
      prefixes: ['VITE_'],
      processEnv: {},
    }),
    {},
  )
})

test('parseDotenv handles quotes, comments and export', () => {
  assert.deepEqual(parseDotenv('A=1\nB="x y"\nC=z # note\nexport D=4\n'), {
    A: '1',
    B: 'x y',
    C: 'z',
    D: '4',
  })
})
