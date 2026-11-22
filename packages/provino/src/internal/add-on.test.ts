import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  addOnFailure,
  DialectNotInstalledError,
  DialectVersionMismatchError,
  importAddOn,
  installCommand,
  isPackageNotFound,
} from './add-on.ts'

/** Node's error for an import of a package that is not installed. */
function notFound(name: string): Error {
  return Object.assign(new Error(`Cannot find package '${name}' imported from /x/dist/cli2.js`), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

test('a missing add-on is DialectNotInstalledError, with the install command', async () => {
  await assert.rejects(
    importAddOn('jest', () => Promise.reject(notFound('@provino/dialect-jest'))),
    (error: unknown) =>
      error instanceof DialectNotInstalledError &&
      error.code === 'PROVINO_DIALECT_NOT_INSTALLED' &&
      error.message.endsWith(`: ${installCommand('jest')}`),
  )
})

test("a package the add-on needs, another add-on's absence and any other error pass through", async () => {
  for (const thrown of [
    notFound('pretty-format'),
    notFound('@provino/dialect-vitest'),
    new TypeError('boom'),
    Object.assign(new Error("Cannot find package '@provino/dialect-jest'"), { code: 'OTHER' }),
  ]) {
    await assert.rejects(
      importAddOn('jest', () => Promise.reject(thrown)),
      (error: unknown) => error === thrown,
    )
  }
  assert.equal(await importAddOn('vitest', () => Promise.resolve(3)), 3)
  assert.equal(isPackageNotFound('not an error', '@provino/dialect-jest'), false)
})

test('addOnFailure finds either error down a cause chain, and a missing add-on Node reported', () => {
  const missing = new DialectNotInstalledError('vitest')
  assert.equal(addOnFailure(missing), missing)
  assert.equal(
    addOnFailure(new Error('outer', { cause: new Error('mid', { cause: missing }) })),
    missing,
  )
  const mismatch = new DialectVersionMismatchError('jest', '0.0.1')
  assert.equal(addOnFailure(new Error('wrapped', { cause: mismatch })), mismatch)
  // A config file's own `import 'provino/jest'` without the add-on: Node's error, under the config's.
  const found = addOnFailure(new Error('config', { cause: notFound('@provino/dialect-jest') }))
  assert.ok(found instanceof DialectNotInstalledError && found.dialect === 'jest')
  assert.equal(addOnFailure(new Error('plain')), undefined)
  assert.equal(addOnFailure(notFound('pretty-format')), undefined)
  const loop: Error = new Error('loop')
  loop.cause = loop
  assert.equal(addOnFailure(loop), undefined)
})

test("the install command pins the add-on to provino's own version (npm's latest need not be it)", () => {
  const version = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  assert.equal(installCommand('jest'), `pnpm add -D @provino/dialect-jest@${version.version}`)
  assert.ok(new DialectNotInstalledError('vitest').message.endsWith(installCommand('vitest')))
  const mismatch = new DialectVersionMismatchError('jest', '0.0.1')
  assert.equal(mismatch.code, 'PROVINO_DIALECT_VERSION_MISMATCH')
  assert.equal(
    mismatch.message,
    `@provino/dialect-jest 0.0.1 is installed, but provino is ${version.version}: ${installCommand('jest')}`,
  )
})
