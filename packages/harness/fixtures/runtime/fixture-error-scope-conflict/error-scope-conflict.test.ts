const base = test.extend({ value: [1, { scope: 'file' }] })
base.extend({ value: [2, { scope: 'test' }] })

test('never collected', () => trace('never'))
