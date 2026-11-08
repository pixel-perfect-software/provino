const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let late: ((reason?: unknown) => void) | undefined

test('finishes, and keeps its done', (done) => {
  trace('first test body')
  late = done
  done()
})

test('calls the first done again, with a reason, while it runs', async () => {
  trace('second test starts')
  await sleep(20)
  try {
    late?.(new Error('late reason'))
    trace('late done returned')
  } catch (error) {
    trace(`late done threw: ${error.message}`)
  }
  await sleep(100)
  trace('second test ends')
})

test('runs after it', () => trace('third test'))
