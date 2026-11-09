const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('leaves a throwing timer behind', () => {
  trace('first test body')
  setTimeout(() => {
    trace('the timer fires')
    throw new Error('thrown after its test ended')
  }, 40)
})

test('is running when it fires', async () => {
  trace('second test starts')
  await sleep(250)
  trace('second test ends')
})

test('runs after the error', () => trace('third test'))
