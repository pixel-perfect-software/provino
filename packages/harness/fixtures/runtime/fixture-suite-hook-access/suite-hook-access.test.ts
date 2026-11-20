const myTest = test.extend({
  perTest: async ({ task: _task }, use) => {
    await use('t')
  },
  perFile: [
    async ({ task: _task }, use) => {
      trace('perFile setup')
      await use('f')
      trace('perFile teardown')
    },
    { scope: 'file' },
  ],
})

describe('a file fixture in test.beforeAll', () => {
  myTest.beforeAll(({ perFile }) => {
    trace(`beforeAll got ${perFile}`)
  })
  myTest.afterAll(({ perFile }) => {
    trace(`afterAll got ${perFile}`)
  })
  myTest('runs', ({ perFile }) => trace(`test got ${perFile}`))
})

describe('a test fixture in test.beforeAll', () => {
  myTest.beforeAll(({ perTest }) => {
    trace(`never ${perTest}`)
  })
  myTest('does not run', () => trace('never body'))
})

describe('a plain beforeAll that destructures', () => {
  beforeAll(({ perFile }) => {
    trace(`never plain ${perFile}`)
  })
  myTest('does not run either', () => trace('never body 2'))
})

test('a later test runs', () => trace('later'))
