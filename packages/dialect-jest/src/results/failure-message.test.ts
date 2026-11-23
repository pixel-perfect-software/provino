// Provino's own frames are left out of the failure text Jest's `jest-message-util` builds (D104):
// from an install (`node_modules/provino`, `node_modules/@provino/<name>`, which that package does
// not drop, as it drops only `jest*` frames) and from a checkout, with percent-encoded paths too.
import assert from 'node:assert/strict'
import { describe, it } from 'provino'
import { formatFileError, formatTestFailures, hideProvinoFrames } from './failure-message.ts'
import type { AssertionResult } from './types.ts'

const config = { rootDir: '/app', testMatch: ['**/*.test.ts'] }

function stack(...frames: string[]): string {
  return ['Error: boom', ...frames.map((frame) => `    at ${frame}`)].join('\n')
}

const INSTALLED = stack(
  'Object.<anonymous> (/app/a.test.ts:3:11)',
  'run (/app/node_modules/provino/dist/worker/jest-runtime.js:1:100)',
  'go (/app/node_modules/@provino/core/dist/index.js:1:100)',
)

describe('hideProvinoFrames', () => {
  it('drops an install’s frames and keeps the test’s', () => {
    assert.equal(
      hideProvinoFrames(INSTALLED, undefined),
      stack('Object.<anonymous> (/app/a.test.ts:3:11)'),
    )
  })

  it('finds a checkout through a percent-encoded frame, and keeps tests and fixtures under packages/', () => {
    const packages = '/work/my app/provino/packages/'
    const text = stack(
      'a (file:///work/my%20app/provino/packages/core/src/x.ts:1:1)',
      'b (/work/my app/provino/packages/provino/dist/worker/y.js:1:1)',
      't (/work/my app/provino/packages/provino/test/run.test.ts:1:1)',
    )
    assert.equal(
      hideProvinoFrames(text, packages),
      stack('t (/work/my app/provino/packages/provino/test/run.test.ts:1:1)'),
    )
  })
})

describe('the failure text of an install', () => {
  const assertion = {
    ancestorTitles: [],
    failureDetails: [],
    failureMessages: [INSTALLED],
    fullName: 'fails',
    numPassingAsserts: 0,
    status: 'failed',
    title: 'fails',
  } as unknown as AssertionResult

  it('has none of Provino’s frames for a failed test', async () => {
    const text = await formatTestFailures(
      [assertion],
      config,
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    assert.match(text ?? '', /a\.test\.ts:3:11/)
    assert.doesNotMatch(text ?? '', /node_modules\/(provino|@provino)/)
  })

  it('prints an error whose message changed after it was made from its stack, as Jest does', async () => {
    // dom-testing-library's `waitFor` appends the DOM to a timed-out error's `message` after the
    // stack was captured, so `failureMessages` (message, then the stack) holds the DOM twice. Jest
    // formats the error itself (`failureDetailsToErrorOrStack`), whose `stack` has it once.
    const message = 'Unable to find it.\n\n<body />\n\n<html />'
    const errorStack =
      'Error: Unable to find it.\n\n<body />\n    at Object.<anonymous> (/app/a.test.ts:3:11)'
    const real = new Error(message)
    real.stack = errorStack
    const hidden = { writable: true, configurable: true, enumerable: false }
    const detail = {}
    Object.defineProperty(detail, 'name', { ...hidden, value: 'Error' })
    Object.defineProperty(detail, 'message', { ...hidden, value: message })
    Object.defineProperty(detail, 'stack', { ...hidden, value: errorStack })
    const flattened = message + errorStack
    const withDetail = (failureDetails: unknown) =>
      ({
        ...assertion,
        failureDetails: [failureDetails],
        failureMessages: [flattened],
      }) as unknown as AssertionResult
    const jest = await import('jest-message-util')
    const expected = jest.formatResultsErrors(
      [withDetail(real)] as unknown as Parameters<typeof jest.formatResultsErrors>[0],
      config as unknown as Parameters<typeof jest.formatResultsErrors>[1],
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    const text = await formatTestFailures(
      [withDetail(detail)],
      config,
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    assert.equal(text, expected)
    assert.equal(text?.split('<body />').length, 2)
  })

  it('prints a thrown object with a message and a stack from its flattened text, as Jest does', async () => {
    // Jest formats the thrown value's own `stack` only when it is an Error
    // (`failureDetailsToErrorOrStack`); a plain `{ message, stack }` is formatted from
    // `failureMessages`, which puts the message in front of the stack (`flattenErrorStack`): its
    // `message` and `stack` are enumerable, as an Error's are not.
    const jest = await import('jest-message-util')
    const thrown = { message: 'the message', stack: 'the stack' }
    const withDetail = {
      ...assertion,
      failureDetails: [thrown],
      failureMessages: [jest.flattenErrorStack(thrown as Error)],
    } as unknown as AssertionResult
    assert.equal(withDetail.failureMessages[0], 'the messagethe stack')
    const expected = jest.formatResultsErrors(
      [withDetail] as unknown as Parameters<typeof jest.formatResultsErrors>[0],
      config as unknown as Parameters<typeof jest.formatResultsErrors>[1],
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    const text = await formatTestFailures(
      [withDetail],
      config,
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    assert.equal(text, expected)
    assert.match(text ?? '', /the messagethe stack/)
  })

  it('has none for an error that kept the file from running', async () => {
    const text = await formatFileError(
      { message: 'boom', stack: INSTALLED },
      config,
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    assert.doesNotMatch(text, /node_modules\/(provino|@provino)/)
  })

  it('prints the message of an error with no stack (a file the run cut off), not the object', async () => {
    // Provino's own errors for a file (`Interrupted`, a worker crash) have a message and no stack;
    // `formatExecError` dumps an object with no stack as `thrown: Object { "message": …, "stack": null }`.
    for (const stack of [null, undefined]) {
      const text = await formatFileError(
        { message: 'The run was interrupted while a.test.ts was running', stack },
        config,
        { noStackTrace: false },
        '/app/a.test.ts',
      )
      assert.equal(
        text,
        '  ● Test suite failed to run\n\n    The run was interrupted while a.test.ts was running\n',
      )
    }
  })
})
