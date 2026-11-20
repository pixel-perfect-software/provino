const myTest = test.extend({
  a: async ({ task: _task }, use) => {
    trace('a setup')
    await use('a')
    trace('a teardown')
  },
  b: async ({ a }, use) => {
    trace('b setup')
    await use(`${a}b`)
    trace('b teardown')
  },
  c: async ({ b }, use) => {
    trace('c setup')
    await use(`${b}c`)
    trace('c teardown')
  },
  broken: async ({ a }, _use) => {
    trace(`broken setup after ${a}`)
    throw new Error('setup failed')
  },
})

beforeEach(() => {
  trace('beforeEach')
  return () => trace('beforeEach cleanup')
})
afterEach(() => trace('afterEach'))

myTest('the order', ({ c, onTestFinished }) => {
  onTestFinished(() => trace('onTestFinished'))
  trace(`body ${c}`)
})

myTest('a setup that throws', ({ broken }) => {
  trace(`never ${broken}`)
})

myTest('a later test', ({ a }) => trace(`later ${a}`))
