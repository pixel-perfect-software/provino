beforeEach(() => {
  trace('beforeEach L1')
  return () => trace('teardown beforeEach L1')
})
afterEach(() => trace('afterEach L1'))

test('passing', (ctx) => {
  trace('test passing')
  onTestFinished((c) => trace(`onTestFinished global #1, gets the context: ${c === ctx}`))
  ctx.onTestFinished(() => trace('onTestFinished ctx #2'))
  onTestFinished(() => trace('onTestFinished global #3'))
  onTestFailed(() => trace('onTestFailed global #1'))
  ctx.onTestFailed(() => trace('onTestFailed ctx #2'))
})

test('failing', (ctx) => {
  trace('test failing')
  onTestFinished((c) => trace(`onTestFinished global #1, gets the context: ${c === ctx}`))
  ctx.onTestFinished(() => trace('onTestFinished ctx #2'))
  onTestFinished(() => trace('onTestFinished global #3'))
  onTestFailed((c) => trace(`onTestFailed global #1, gets the context: ${c === ctx}`))
  ctx.onTestFailed(() => trace('onTestFailed ctx #2'))
  onTestFailed(() => trace('onTestFailed global #3'))
  throw new Error('failing test failed')
})

describe('L2', () => {
  beforeEach(() => {
    trace('beforeEach L2')
    return () => trace('teardown beforeEach L2')
  })
  afterEach(() => trace('afterEach L2'))

  test('nested failing', (ctx) => {
    trace('test nested failing')
    onTestFinished(() => trace('onTestFinished global #1'))
    ctx.onTestFinished(() => trace('onTestFinished ctx #2'))
    onTestFailed(() => trace('onTestFailed global #1'))
    ctx.onTestFailed(() => trace('onTestFailed ctx #2'))
    throw new Error('nested test failed')
  })
})
