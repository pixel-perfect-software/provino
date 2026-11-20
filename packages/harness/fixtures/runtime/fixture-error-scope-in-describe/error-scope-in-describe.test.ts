describe('block', () => {
  test.extend({ value: [1, { scope: 'file' }] })
  test('never collected', () => trace('never'))
})
