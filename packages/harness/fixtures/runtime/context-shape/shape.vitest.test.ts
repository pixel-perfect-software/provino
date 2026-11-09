const OURS = ['annotate', 'onTestFailed', 'onTestFinished', 'signal', 'skip', 'task']
let seen: unknown
beforeEach((ctx) => {
  seen = ctx
})

test('the context of a test', (ctx) => {
  trace(`same object as beforeEach: ${ctx === seen}`)
  trace(`typeof: ${typeof ctx}`)
  trace(
    `keys: ${JSON.stringify(
      Object.keys(ctx)
        .filter((key) => OURS.includes(key))
        .sort(),
    )}`,
  )
  trace(`task: ${ctx.task.name} ${ctx.task.type} ${ctx.task.mode}`)
  trace(`signal: ${ctx.signal instanceof AbortSignal} aborted=${ctx.signal.aborted}`)
  trace(
    `functions: ${['skip', 'annotate', 'onTestFinished', 'onTestFailed'].map((key) => typeof ctx[key]).join(' ')}`,
  )
  try {
    ctx()
    trace('calling the context did not throw')
  } catch (error) {
    trace(`calling the context threw: ${error.message}`)
  }
})

test('a second test gets its own context', (ctx) => {
  trace(`beforeEach context is this test's: ${ctx === seen} ${ctx.task.name}`)
})

afterEach((ctx) => {
  trace(`afterEach context: ${ctx === seen}`)
})

describe('a suite', () => {
  test('task of a nested test', (ctx) => {
    trace(`nested task: ${ctx.task.name}`)
  })
})
