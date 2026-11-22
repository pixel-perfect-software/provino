import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DialectNotInstalledError,
  dialectNotInstalled,
  importAddOn,
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
      error.message.endsWith(': pnpm add -D @provino/dialect-jest'),
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

test('dialectNotInstalled finds the error down a cause chain, and nothing else', () => {
  const missing = new DialectNotInstalledError('vitest')
  assert.equal(dialectNotInstalled(missing), missing)
  assert.equal(
    dialectNotInstalled(new Error('outer', { cause: new Error('mid', { cause: missing }) })),
    missing,
  )
  assert.equal(dialectNotInstalled(new Error('plain')), undefined)
  const loop: Error = new Error('loop')
  loop.cause = loop
  assert.equal(dialectNotInstalled(loop), undefined)
})
