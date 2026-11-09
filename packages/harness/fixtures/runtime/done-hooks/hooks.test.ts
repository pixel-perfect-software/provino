beforeAll((done) => {
  trace('beforeAll')
  setTimeout(done, 10)
})

beforeEach((done) => {
  trace('beforeEach')
  done()
})

afterEach((done) => {
  trace('afterEach')
  done()
})

afterAll((done) => {
  trace('afterAll')
  done()
})

test('first', () => trace('test first'))
test('second', () => trace('test second'))

describe('a hook that never calls done', () => {
  beforeEach((_done) => {
    trace('beforeEach that never calls done')
  }, 100)
  test('inside', () => trace('test inside'))
})

describe('a hook that calls done with an error', () => {
  afterEach((done) => {
    done(new Error('hook failed through done'))
  })
  test('inside', () => trace('test inside, afterEach fails'))
})
