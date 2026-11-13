// `globalSetupFailure` (T9.15): how a failing Jest global hook is reported, as `runGlobalHook` does.
// The texts are the four recordings' (`cli/global-setup-throws`, `-typeerror`, `-object`,
// `-string`), which `@provino/harness`'s policy-truth claim and `provino`'s `global-setup.test.ts`
// hold to the real Jest; these cover what a recording can't: an error whose message can't be
// rewritten, a value pretty-format can't print, and what is left of the thrown error.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globalSetupFailure } from './index.ts'

const context = { hook: 'globalSetup', path: '/the/setup.ts' } as const
const header = 'Jest: Got error running globalSetup - /the/setup.ts, reason: '

test('an Error is rewritten in place and kept: its class, its stack and its other properties stay', () => {
  const thrown = Object.assign(new TypeError('setup failed\nsecond line'), { code: 'E_SETUP' })
  const { stack } = thrown
  const reported = globalSetupFailure(thrown, context)
  assert.equal(reported, thrown)
  assert.ok(reported instanceof TypeError)
  assert.equal(reported.message, `${header}setup failed\nsecond line`)
  assert.equal(reported.stack, stack, 'the stack is the one captured where it was thrown')
  assert.equal(Reflect.get(reported, 'code'), 'E_SETUP')
})

test('the teardown is named by its own hook', () => {
  const reported = globalSetupFailure(new Error('down'), {
    hook: 'globalTeardown',
    path: '/the/teardown.ts',
  })
  assert.equal(
    reported.message,
    'Jest: Got error running globalTeardown - /the/teardown.ts, reason: down',
  )
})

test('an Error subclass whose message lives on its prototype is still rewritten, and keeps its class', () => {
  class Quiet extends Error {}
  Object.defineProperty(Quiet.prototype, 'message', { value: 'from the prototype', writable: true })
  const thrown = new Quiet()
  Reflect.deleteProperty(thrown, 'message')
  const reported = globalSetupFailure(thrown, context)
  assert.equal(reported, thrown)
  assert.equal(reported.message, `${header}from the prototype`)
})

test('an Error whose message can’t be rewritten is reported as a new Error, the value as pretty-format prints it', () => {
  const thrown = new RangeError('fixed')
  Object.defineProperty(thrown, 'message', { value: 'fixed', writable: false })
  Object.defineProperty(Object.getPrototypeOf(thrown), 'message', {
    value: '',
    writable: false,
    configurable: true,
  })
  try {
    const reported = globalSetupFailure(thrown, context)
    assert.notEqual(reported, thrown)
    assert.equal(reported.name, 'Error')
    assert.match(
      reported.message,
      /^Jest: Got error running globalSetup - \/the\/setup\.ts, reason: /,
    )
    assert.match(reported.message, /RangeError/, 'pretty-format names the class')
    assert.equal(thrown.message, 'fixed', 'the thrown error is left as it was')
  } finally {
    Object.defineProperty(Object.getPrototypeOf(thrown), 'message', {
      value: '',
      writable: true,
      configurable: true,
    })
  }
})

test('a value that is no Error is printed by pretty-format three levels deep, and the new Error’s stack is its header alone', () => {
  const object = globalSetupFailure(
    { code: 42, detail: { list: ['a', 'b'], deeper: { deepest: { gone: true } } } },
    context,
  )
  assert.equal(
    object.message,
    `${header}Object {\n  "code": 42,\n  "detail": Object {\n    "deeper": Object {\n      "deepest": [Object],\n    },\n    "list": Array [\n      "a",\n      "b",\n    ],\n  },\n}`,
  )
  assert.equal(object.stack, `Error: ${object.message}`, 'no frame of ours')
  const string = globalSetupFailure('setup gave up', context)
  assert.equal(string.message, `${header}"setup gave up"`)
  assert.equal(string.stack, `Error: ${string.message}`)
  assert.equal(globalSetupFailure(undefined, context).message, `${header}undefined`)
})

test('a value pretty-format throws on is reported as text, not as the failure of the report', () => {
  const hostile = {
    get boom(): never {
      throw new Error('a getter that throws')
    },
  }
  const reported = globalSetupFailure(hostile, context)
  assert.equal(reported.message, `${header}[object Object]`)
})
