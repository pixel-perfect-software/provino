test.extend({ value: [1, { scope: 'suite' }] })

test('never collected', () => trace('never'))
