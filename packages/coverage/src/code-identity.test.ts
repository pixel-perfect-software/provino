// The instrumenter's cache identity: an edit to the package's code (its own, or a vendored patch)
// changes it. Run against a temp copy of `src/`, never the real files.
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { codeIdentityOf } from './code-identity.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function copyOfSrc(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provino-coverage-identity-'))
  dirs.push(dir)
  cpSync(fileURLToPath(new URL('./', import.meta.url)), dir, { recursive: true })
  return dir
}

test('a byte changed in instrument.ts or in a vendored file changes the identity', () => {
  const base = codeIdentityOf(copyOfSrc())
  assert.equal(base, codeIdentityOf(copyOfSrc()), 'a copy is the same')
  const edited = copyOfSrc()
  appendFileSync(join(edited, 'instrument.ts'), '\n')
  assert.notEqual(base, codeIdentityOf(edited))
  const patched = copyOfSrc()
  appendFileSync(join(patched, 'vendor/istanbul-lib-instrument/visitor.ts'), '\n')
  assert.notEqual(base, codeIdentityOf(patched))
})
