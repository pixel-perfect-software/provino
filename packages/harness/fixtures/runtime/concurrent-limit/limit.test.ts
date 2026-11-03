const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let inFlight = 0
let peak = 0

describe('seven concurrent tests', () => {
  afterAll(() => trace(`peak ${peak}`))

  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    test.concurrent(`c${n}`, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      trace(`test c${n} start`)
      await sleep(30 + n * 20)
      inFlight--
      trace(`test c${n} end`)
    })
  }
})
