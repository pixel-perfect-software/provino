jest.retryTimes(2, { retryImmediately: true })

const calls: Record<string, number> = {}

/** A test body that fails its first `failures` calls and traces every call. */
function flaky(name: string, failures: number): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    if (calls[name] <= failures) throw new Error(`${name} failed #${calls[name]}`)
  }
}

test('a fails once', flaky('a', 1))
test('b passes', () => trace('b'))
test('c fails twice', flaky('c', 2))
test('d fails every time', flaky('d', 99))

describe('nested', () => {
  test('e fails once', flaky('e', 1))
  test('f passes', () => trace('f'))
})

test('g passes', () => trace('g'))
