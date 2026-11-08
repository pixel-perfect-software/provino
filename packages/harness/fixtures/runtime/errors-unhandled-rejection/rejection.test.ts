const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('leaves a rejected promise behind', () => {
  trace('first test body')
  void Promise.reject(new Error('rejected and left unhandled'))
})

test('rejects and then waits for it to settle', async () => {
  trace('second test body')
  void Promise.reject(new Error('rejected, then the test waited'))
  await sleep(60)
  trace('second test ends')
})

test('makes a rejection in a timer', () => {
  trace('third test body')
  setTimeout(() => {
    trace('the timer rejects')
    void Promise.reject(new Error('rejected in a timer after its test ended'))
  }, 40)
})

test('is running when the timer rejects', async () => {
  trace('fourth test starts')
  await sleep(250)
  trace('fourth test ends')
})

test('runs after the errors', () => trace('fifth test'))
