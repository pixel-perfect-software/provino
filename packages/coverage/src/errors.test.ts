import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CoverageError } from './errors.ts'

describe('CoverageError', () => {
  test('carries its code and message, and names itself', () => {
    const error = new CoverageError('COVERAGE_NOT_IMPLEMENTED', 'the AST converter is B25')
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'CoverageError')
    assert.equal(error.code, 'COVERAGE_NOT_IMPLEMENTED')
    assert.equal(error.message, 'the AST converter is B25')
  })

  test('keeps the cause', () => {
    const cause = new Error('boom')
    const error = new CoverageError('COVERAGE_INSTRUMENT_FAILED', 'could not instrument', { cause })
    assert.equal(error.cause, cause)
  })
})
