import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import type { SerializedLoaderConfig } from '@provino/types'
import { createProjectLoader } from './project.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-project-resolution-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const CONFIG: SerializedLoaderConfig = {
  hoist: null,
  moduleScope: [],
  extensions: ['.js', '.cjs', '.json'],
  conditions: ['node'],
  tsconfig: false,
  mappers: [],
  typescript: 'oxc',
}

// T3.3: the resolver keys of the config reach the worker's resolver.
test('aliases, modulePaths, moduleDirectories and a custom resolver reach the resolver', async () => {
  const root = writeTree({
    'src/real.cjs': "exports.which = 'real'\n",
    'shared/found.cjs': "exports.which = 'shared'\n",
    'vendor/lib/index.cjs': "exports.which = 'vendor'\n",
    'resolver.cjs':
      "module.exports = (path, options) => path === 'custom' ? options.rootDir + '/src/real.cjs' : options.defaultResolver(path, options)\n",
    'entry.test.cjs': [
      "exports.aliased = require('@app/real').which",
      "exports.paths = require('found').which",
      "exports.dirs = require('lib').which",
      '',
    ].join('\n'),
    'custom.test.cjs': "exports.custom = require('custom').which\n",
  })
  const config: SerializedLoaderConfig = {
    ...CONFIG,
    aliases: [{ pattern: '^@app/(.*)$', targets: ['<rootDir>/src/$1.cjs'] }],
    modulePaths: [join(root, 'shared')],
    moduleDirectories: ['vendor'],
  }
  const loader = await createProjectLoader(root, config, neutralPolicy.module)
  const entry = join(root, 'entry.test.cjs')
  const required = loader
    .createFileRegistry(entry, { tier: 'registry' })
    .require<{ aliased: string; paths: string; dirs: string }>(entry)
  assert.deepEqual({ ...required }, { aliased: 'real', paths: 'shared', dirs: 'vendor' })

  const withResolver = await createProjectLoader(
    root,
    { ...CONFIG, resolver: { module: join(root, 'resolver.cjs'), export: 'default' } },
    neutralPolicy.module,
  )
  const custom = join(root, 'custom.test.cjs')
  const loaded = withResolver
    .createFileRegistry(custom, { tier: 'registry' })
    .require<{ custom: string }>(custom)
  assert.equal(loaded.custom, 'real')
})
