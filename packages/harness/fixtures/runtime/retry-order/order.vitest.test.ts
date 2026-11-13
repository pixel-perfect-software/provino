const retry = { retry: 2 }

const calls: Record<string, number> = {}

/** A test body that fails its first `failures` calls and traces every call. */
function flaky(name: string, failures: number): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    if (calls[name] <= failures) throw new Error(`${name} failed #${calls[name]}`)
  }
}

test('a fails once', retry, flaky('a', 1))
test('b passes', retry, () => trace('b'))
test('c fails twice', retry, flaky('c', 2))
test('d fails every time', retry, flaky('d', 99))

describe('nested', () => {
  test('e fails once', retry, flaky('e', 1))
  test('f passes', retry, () => trace('f'))
})

test('g passes', retry, () => trace('g'))
