const myTest = test.extend({
  perFile: [
    async ({ task: _task }, use) => {
      trace('perFile setup')
      await use({ n: 0 })
      trace('perFile teardown')
    },
    { scope: 'file' },
  ],
  perTest: async ({ perFile }, use) => {
    perFile.n++
    trace(`perTest setup ${perFile.n}`)
    await use(perFile.n)
    trace('perTest teardown')
  },
  config: [{ mode: 'static' }, { scope: 'file' }],
})

afterAll(() => trace('afterAll'))

describe('a block', () => {
  myTest('one', ({ perTest }) => trace(`one ${perTest}`))
  myTest('two', ({ perTest }) => trace(`two ${perTest}`))
})

myTest('three', ({ perFile, config }) => trace(`three ${perFile.n} ${config.mode}`))
