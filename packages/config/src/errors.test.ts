import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatConfigIssue } from './errors.ts'

describe('formatConfigIssue', () => {
  test('indents the path and message', () => {
    assert.equal(formatConfigIssue({ path: 'a.0.b', message: 'bad' }), '  a.0.b: bad')
  })

  test('names the options as a whole when the path is empty', () => {
    assert.equal(
      formatConfigIssue({ path: '', message: 'must be an object' }),
      '  (options): must be an object',
    )
  })
})
