// The first test leaves a timer behind that throws once the second test is running.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('leaves a throwing timer behind', () => {
  setTimeout(() => {
    throw new Error('thrown after its test ended')
  }, 30)
})

test('is running when it fires', () => sleep(200))
