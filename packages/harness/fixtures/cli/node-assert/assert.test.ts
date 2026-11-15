import assert from 'node:assert'

const received = { a: 1, b: [1, 2, 3], c: 'x' }
const expected = { a: 1, b: [1, 2, 4], c: 'y' }

it('equal', () => {
  assert.equal(1, 2)
})

it('notEqual', () => {
  assert.notEqual(1, 1)
})

it('strictEqual', () => {
  assert.strictEqual('a', 'b')
})

it('deepStrictEqual of objects', () => {
  assert.deepStrictEqual(received, expected)
})

it('deepEqual', () => {
  assert.deepEqual([1, 2], [1, 3])
})

it('ok', () => {
  assert.ok(false)
})

it('throws without a throw', () => {
  assert.throws(() => {})
})

it('throws with the wrong error', () => {
  assert.throws(() => {
    throw new Error('boom')
  }, /other/)
})

it('doesNotThrow', () => {
  assert.doesNotThrow(() => {
    throw new Error('boom')
  })
})

it('match', () => {
  assert.match('abc', /x/)
})

it('fail with a message', () => {
  assert.fail('gave up')
})

it('fail without a message', () => {
  assert.fail()
})

it('custom message', () => {
  assert.strictEqual(1, 2, 'one is not two')
})

it('an AssertionError built by hand', () => {
  throw new assert.AssertionError({
    message: 'by hand',
    actual: 1,
    expected: 2,
    operator: 'strictEqual',
  })
})

it('rejects', async () => {
  await assert.rejects(Promise.resolve(1))
})

it('an error that only carries the code', () => {
  throw Object.assign(new Error('looks like one'), {
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 2,
    operator: '==',
  })
})

describe('inside a describe', () => {
  it('strictEqual', () => {
    assert.strictEqual(received.c, expected.c)
  })

  describe('nested', () => {
    beforeEach(() => {
      assert.notStrictEqual(1, 1)
    })
    it('never runs', () => {})
  })
})
