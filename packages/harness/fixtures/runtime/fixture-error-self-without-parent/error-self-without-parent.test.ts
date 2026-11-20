test.extend({
  value: async ({ value }, use) => {
    await use(value)
  },
})

test('never collected', () => trace('never'))
