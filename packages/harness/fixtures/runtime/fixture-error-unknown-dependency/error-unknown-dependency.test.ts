test.extend({
  value: async ({ missing }, use) => {
    await use(missing)
  },
})

test('never collected', () => trace('never'))
