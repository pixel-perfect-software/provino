const myTest = test.extend({
  perTest: 1,
})

describe('a plain beforeAll that destructures', () => {
  beforeAll(({ perTest }) => {
    trace(`never ${perTest}`)
  })
  test('does not run', () => undefined)
})

describe('a plain beforeAll with a named first parameter', () => {
  beforeAll((suite) => {
    trace(`never ${String(suite)}`)
  })
  test('does not run either', () => undefined)
})

describe('a test.beforeAll that reads a test fixture', () => {
  myTest.beforeAll(({ perTest }) => {
    trace(`never ${perTest}`)
  })
  myTest('does not run at all', () => undefined)
})
