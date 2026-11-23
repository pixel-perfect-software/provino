// What the claims make of a `node_modules` file, on its own: `user` for a file Node can't load,
// `native` for one it can, and never a read of a binary or data file as source. End to end against
// Jest 30.5.2 is `provino`'s `transform-node-modules.test.ts`.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'provino'
import { claimedLoad, isClaimedExternal, isClaimedUserModule } from './claims.ts'
import { createRecords } from './records.ts'
import { loaderOptionsFor, writeTree } from './test-support.ts'

/** Text no lexer accepts and no engine runs; it holds the module words, so a read would find them. */
const SOURCE_LIKE = "import { a } from './a'\nexport const b = }\n"

const root = writeTree({
  'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', main: 'index.js' }),
  'node_modules/pkg/index.js': "module.exports = require('./styles.css')\n",
  'node_modules/pkg/styles.css': '.a { color: red }\n',
  'node_modules/pkg/image.svg': '<svg></svg>\n',
  'node_modules/pkg/readme.md': 'plain text\n',
  'node_modules/pkg/typed.ts': 'export const a: number = 1\n',
  'node_modules/pkg/plain.js': 'module.exports = 1\n',
  'node_modules/pkg/esm.js': 'export const a = 1\n',
  'node_modules/pkg/addon.node': SOURCE_LIKE,
  'node_modules/pkg/module.wasm': SOURCE_LIKE,
  'node_modules/pkg/data.json': SOURCE_LIKE,
})

function recordsFor(patterns: string[]) {
  const records = createRecords(
    loaderOptionsFor(root, { transformClaims: { patterns, ignorePatterns: [] } }),
  )
  assert.notEqual(records.claims, null)
  return records.claims
}

test('a claimed file Node does not load as JavaScript is a user module, whatever its text holds', () => {
  const claims = recordsFor(['.*'])
  assert.ok(claims !== null)
  for (const file of ['styles.css', 'image.svg', 'readme.md', 'typed.ts']) {
    assert.equal(isClaimedUserModule(claims, join(root, 'node_modules/pkg', file)), true, file)
  }
})

test('a claimed file Node loads stays native unless it has ES module syntax', () => {
  const claims = recordsFor(['.*'])
  assert.ok(claims !== null)
  const at = (file: string) => join(root, 'node_modules/pkg', file)
  assert.equal(isClaimedUserModule(claims, at('esm.js')), true)
  assert.equal(isClaimedUserModule(claims, at('plain.js')), false)
  assert.equal(isClaimedExternal(claims, at('plain.js')), true)
  assert.equal(claimedLoad(claims, at('plain.js')), 'untried')
  assert.equal(claimedLoad(claims, at('esm.js')), 'user')
})

test('an addon, a WebAssembly module and a JSON file are native and never read as source', () => {
  const claims = recordsFor(['.*'])
  assert.ok(claims !== null)
  for (const file of ['addon.node', 'module.wasm', 'data.json']) {
    const path = join(root, 'node_modules/pkg', file)
    assert.equal(isClaimedUserModule(claims, path), false, file)
    assert.equal(claims.verdicts.get(path), 'native', file)
  }
})
