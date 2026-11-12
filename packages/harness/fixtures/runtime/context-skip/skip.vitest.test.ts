afterEach(() => trace('afterEach'))

test('skips itself', (ctx) => {
  trace('before skip')
  ctx.skip()
  trace('after skip')
})

test('skips with a note', (ctx) => {
  ctx.skip('not today')
  trace('after skip with a note')
})

test('skip(true, note)', (ctx) => {
  ctx.skip(true, 'conditional skip')
  trace('after skip(true)')
})

test('skip(false) carries on', (ctx) => {
  ctx.skip(false, 'not skipped')
  trace('after skip(false)')
})

test('onTestFinished and onTestFailed after a skip', (ctx) => {
  ctx.onTestFinished(() => trace('onTestFinished'))
  ctx.onTestFailed(() => trace('onTestFailed'))
  ctx.skip()
})

test('a test after the skips still runs', () => trace('a later test ran'))

describe('skip in a beforeEach', () => {
  beforeEach((ctx) => {
    trace('beforeEach before skip')
    ctx.skip('skipped by beforeEach')
  })
  test('is skipped by its beforeEach', () => trace('body: never runs'))
})

describe('skip after a failure', () => {
  test('throws, then skip is not reached', (ctx) => {
    ctx.onTestFailed(() => trace('onTestFailed after throw'))
    throw new Error('failed before skip')
  })
})
