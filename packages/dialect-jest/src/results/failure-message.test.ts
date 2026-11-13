// Provino's own frames are left out of the failure text Jest's `jest-message-util` builds (D104):
// from an install (`node_modules/provino`, `node_modules/@provino/<name>`, which that package does
// not drop, as it drops only `jest*` frames) and from a checkout, with percent-encoded paths too.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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

  it('has none for an error that kept the file from running', async () => {
    const text = await formatFileError(
      { message: 'boom', stack: INSTALLED },
      config,
      { noStackTrace: false },
      '/app/a.test.ts',
    )
    assert.doesNotMatch(text, /node_modules\/(provino|@provino)/)
  })
})
