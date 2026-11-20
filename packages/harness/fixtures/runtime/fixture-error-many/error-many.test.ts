test.extend({
  first: [1, { scope: 'suite' }],
  second: [2, { scope: 'nowhere' }],
})

test('never collected', () => trace('never'))
