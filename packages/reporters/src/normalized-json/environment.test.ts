import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readRunEnvironment } from './environment.ts'

describe('readRunEnvironment', () => {
  test('reads ci from CI when it is set to anything but empty, 0 or false, ignoring case and spaces', () => {
    for (const value of ['true', '1', 'yes', 'TRUE', ' true ', 'github']) {
      assert.equal(readRunEnvironment({}, { CI: value }).ci, true, JSON.stringify(value))
    }
    for (const value of ['', '0', 'false', 'FALSE', 'False', ' false ', ' 0 ', ' ']) {
      assert.equal(readRunEnvironment({}, { CI: value }).ci, false, JSON.stringify(value))
    }
    assert.equal(readRunEnvironment({}, {}).ci, false)
  })

  test('names the runners it is given', () => {
    assert.deepEqual(readRunEnvironment({ provino: '1.2.3' }, {}).runners, { provino: '1.2.3' })
  })
})
