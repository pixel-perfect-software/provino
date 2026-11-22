import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  AddOnError,
  addOnFailure,
  installCommand,
  notInstalled,
  reportAddOnFailure,
} from './add-on.ts'

/** Node's error for an import of a package that is not installed. */
function notFound(name: string): Error {
  return Object.assign(new Error(`Cannot find package '${name}' imported from /x/dist/cli2.js`), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

const VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

test("the install command pins the add-on to provino's own version (npm's latest need not be it)", () => {
  assert.equal(installCommand('jest'), `pnpm add -D @provino/dialect-jest@${VERSION}`)
  const missing = notInstalled('vitest')
  assert.equal(missing.code, 'PROVINO_DIALECT_NOT_INSTALLED')
  assert.equal(missing.name, 'AddOnError')
  assert.ok(missing.message.endsWith(installCommand('vitest')))
})

test('addOnFailure finds an AddOnError down a cause chain, and a missing add-on Node reported', () => {
  const missing = notInstalled('vitest')
  assert.equal(addOnFailure(missing), missing)
  assert.equal(
    addOnFailure(new Error('outer', { cause: new Error('mid', { cause: missing }) })),
    missing,
  )
  const other = new AddOnError('PROVINO_DIALECT_OTHER_PROVINO', 'jest', 'two engines')
  assert.equal(addOnFailure(new Error('wrapped', { cause: other })), other)
  // A config file's own `import 'provino/jest'` without the add-on: Node's error, under the config's.
  const found = addOnFailure(new Error('config', { cause: notFound('@provino/dialect-jest') }))
  assert.equal(found?.code, 'PROVINO_DIALECT_NOT_INSTALLED')
  assert.equal(found?.dialect, 'jest')
  // A package the add-on needs, and anything else, is not one.
  assert.equal(addOnFailure(notFound('pretty-format')), undefined)
  assert.equal(addOnFailure(new Error('plain')), undefined)
  assert.equal(addOnFailure('not an error'), undefined)
  const loop: Error = new Error('loop')
  loop.cause = loop
  assert.equal(addOnFailure(loop), undefined)
})

test('reportAddOnFailure writes the one line and gives 1, or nothing for another error', () => {
  let written = ''
  const stderr = { write: (text: string) => (written += text) }
  assert.equal(reportAddOnFailure(notFound('@provino/dialect-vitest'), stderr), 1)
  assert.equal(written, `Provino: ${notInstalled('vitest').message}\n`)
  written = ''
  assert.equal(reportAddOnFailure(new TypeError('boom'), stderr), undefined)
  assert.equal(written, '')
})
