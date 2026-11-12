let first: unknown
beforeEach(function () {
  first = this
  trace(
    `beforeEach this: ${JSON.stringify(Object.keys(this))} proto=${Object.getPrototypeOf(this) === null ? 'null' : 'object'}`,
  )
  this.fromBeforeEach = 1
})

test('the this of a test', function () {
  trace(`same this as beforeEach: ${this === first}`)
  trace(`keys: ${JSON.stringify(Object.keys(this))}`)
  // biome-ignore lint/complexity/noArguments: the fixture records that Jest passes none
  trace(`arguments: ${arguments.length}`)
  this.fromTest = 2
})

test('a second test gets a new this', function () {
  trace(`new this: ${this !== first} keys=${JSON.stringify(Object.keys(this))}`)
})

afterEach(function () {
  trace(`afterEach this: ${this === first} keys=${JSON.stringify(Object.keys(this))}`)
})

describe('a suite', () => {
  test('a nested test gets a new this too', function () {
    trace(`nested: ${this !== first} keys=${JSON.stringify(Object.keys(this))}`)
  })
})
