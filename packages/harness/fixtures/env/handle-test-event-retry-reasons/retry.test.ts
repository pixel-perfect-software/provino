declare const __log: (marker: string) => void

let flaky = 0
jest.retryTimes(2, { logErrorsBeforeRetry: true })

test('fails twice', () => {
  flaky += 1
  __log(`body fails twice ${flaky}`)
  if (flaky < 3) throw new Error(`attempt ${flaky}`)
})
