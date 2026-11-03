import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { createTsconfigFinder, loadEmitOptions, stripJsonc } from './tsconfig.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function writeTree(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'provino-tsconfig-')))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

test('stripJsonc removes comments and trailing commas, never inside strings', () => {
  const text = `{
    // line comment
    "url": "http://example.com/*not-a-comment*/", /* block */
    "quote": "a \\" // still a string",
    "list": [1, 2,],
    "nested": { "a": 1, },
  }`
  assert.deepEqual(JSON.parse(stripJsonc(text)), {
    url: 'http://example.com/*not-a-comment*/',
    quote: 'a " // still a string',
    list: [1, 2],
    nested: { a: 1 },
  })
  assert.deepEqual(JSON.parse(stripJsonc('{"a": 1, // trailing\n}')), { a: 1 })
})

test('extends: arrays apply in order, packages resolve to their tsconfig.json', () => {
  const root = writeTree({
    'node_modules/preset/tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'react', target: 'es2020' },
    }),
    'node_modules/preset/package.json': JSON.stringify({ name: 'preset' }),
    'second.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }),
    'tsconfig.json': JSON.stringify({
      extends: ['preset', './second'],
      compilerOptions: { verbatimModuleSyntax: true, strict: true },
    }),
  })
  assert.deepEqual(loadEmitOptions(join(root, 'tsconfig.json')), {
    emit: { jsx: 'react-jsx', target: 'es2020', verbatimModuleSyntax: true },
    missing: [],
  })
})

test('a cycle in extends is an error', () => {
  const root = writeTree({
    'a.json': JSON.stringify({ extends: './b.json' }),
    'b.json': JSON.stringify({ extends: './a.json' }),
  })
  assert.throws(() => loadEmitOptions(join(root, 'a.json')), {
    code: 'TRANSFORM_TSCONFIG_INVALID',
  })
})

test('the finder returns the nearest tsconfig.json, or null', () => {
  const root = writeTree({ 'tsconfig.json': '{}', 'pkg/tsconfig.json': '{}', 'pkg/src/x.ts': '' })
  const find = createTsconfigFinder()
  assert.equal(find(join(root, 'pkg/src')), join(root, 'pkg/tsconfig.json'))
  assert.equal(find(join(root, 'other')), join(root, 'tsconfig.json'))
  assert.equal(createTsconfigFinder()('/'), null)
})
