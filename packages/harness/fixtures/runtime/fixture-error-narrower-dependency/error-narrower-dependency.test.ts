test.extend({
  perTest: 1,
  perFile: [
    async ({ perTest }, use) => {
      await use(perTest)
    },
    { scope: 'file' },
  ],
})

test('never collected', () => trace('never'))
