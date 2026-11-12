// The build identity: an edit to a code file changes it, a test or declaration file does not.
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { codeIdentityOf, ownCodeIdentity } from './code-identity.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-code-identity-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

test('an edit to a code file, a new file or a rename changes the identity', () => {
  const base = codeIdentityOf(tree({ 'a.ts': 'export const a = 1\n', 'hoist/b.ts': 'x\n' }))
  assert.notEqual(
    base,
    codeIdentityOf(tree({ 'a.ts': 'export const a = 2\n', 'hoist/b.ts': 'x\n' })),
    'edited content',
  )
  assert.notEqual(
    base,
    codeIdentityOf(tree({ 'a.ts': 'export const a = 1\n', 'hoist/b.ts': 'x\n', 'c.ts': '' })),
    'a new file',
  )
  assert.notEqual(
    base,
    codeIdentityOf(tree({ 'a.ts': 'export const a = 1\n', 'hoist/renamed.ts': 'x\n' })),
    'a renamed file',
  )
  assert.equal(base, codeIdentityOf(tree({ 'a.ts': 'export const a = 1\n', 'hoist/b.ts': 'x\n' })))
})

test('tests, declarations, test helpers and node_modules do not count', () => {
  const base = codeIdentityOf(tree({ 'a.ts': 'x\n' }))
  const noise = codeIdentityOf(
    tree({
      'a.ts': 'x\n',
      'a.test.ts': 'y',
      'a.d.ts': 'y',
      'hoist/test-policies.ts': 'y',
      'node_modules/p/index.js': 'y',
      'notes.md': 'y',
    }),
  )
  assert.equal(noise, base)
})

test('the package’s own identity is computed once and is a hash', () => {
  const root = new URL('../', import.meta.url)
  assert.match(ownCodeIdentity(root), /^[0-9a-f]{16}$/)
  assert.equal(ownCodeIdentity(root), ownCodeIdentity(root))
})

test('editing a file under src/runner/ changes the pipeline’s code identity (B20 Gap 8)', () => {
  const src = fileURLToPath(new URL('../', import.meta.url))
  const copy = mkdtempSync(join(tmpdir(), 'provino-code-identity-src-'))
  dirs.push(copy)
  cpSync(src, copy, { recursive: true })
  const before = codeIdentityOf(copy)
  assert.equal(before, codeIdentityOf(src), 'the copy has the same identity')
  appendFileSync(join(copy, 'runner', 'apply.ts'), '\n// edited\n')
  assert.notEqual(codeIdentityOf(copy), before)
})
