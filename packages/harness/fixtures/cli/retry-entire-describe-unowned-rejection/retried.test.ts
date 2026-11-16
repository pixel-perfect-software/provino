// A timer set as the file loads makes a rejection nobody handles 20 ms later, while the first
// attempt of the retried block awaits: no test or hook of the file raised it.
setTimeout(() => {
  void Promise.reject(new Error('rejected by a timer no test owns'))
}, 20)

let attempts = 0

describe('retried whole', () => {
  jest.retryTimes(2, { entireDescribe: true })

  test('fails the first time', async () => {
    attempts++
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (attempts === 1) throw new Error(`failed on attempt ${attempts}`)
  })
})
