const base = test.extend({ value: [1, { auto: true }] })
base.extend({ value: [2, { auto: false }] })

test('never collected', () => trace('never'))
