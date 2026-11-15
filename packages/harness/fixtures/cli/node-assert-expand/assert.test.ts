import assert from 'node:assert'

const keys = 'abcdefghijklmnopqrstuvwxyz'.split('')
const received = Object.fromEntries(keys.map((key, index) => [key, index]))
const expected = { ...received, p: 'changed' }

it('deepStrictEqual of long objects', () => {
  assert.deepStrictEqual(received, expected)
})

it('deepEqual of long arrays', () => {
  assert.deepEqual(
    keys,
    keys.map((key) => (key === 'm' ? 'M' : key)),
  )
})
