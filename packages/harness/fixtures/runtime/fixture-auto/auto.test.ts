const myTest = test.extend({
  autoOne: [
    async ({ task: _task }, use) => {
      trace('auto setup')
      await use(undefined)
      trace('auto teardown')
    },
    { auto: true },
  ],
  named: async ({ task: _task }, use) => {
    trace('named setup')
    await use(1)
  },
  fromConfig: ['default value', { injected: true }],
})

beforeEach(() => trace('beforeEach'))
afterEach(() => trace('afterEach'))

myTest('auto runs without being named', () => trace('body 1'))

myTest('a named one too', ({ named, fromConfig }) => trace(`body 2 ${named} ${fromConfig}`))

test('the base test runs none', () => trace('base body'))
