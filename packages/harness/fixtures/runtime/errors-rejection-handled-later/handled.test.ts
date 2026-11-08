const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('handles its rejection after the first turn', async () => {
  trace('test body')
  const promise = Promise.reject(new Error('rejected, handled a little later'))
  await sleep(20)
  promise.catch(() => trace('handler attached'))
  await sleep(60)
  trace('test ends')
})

test('runs after it', () => trace('second test'))
