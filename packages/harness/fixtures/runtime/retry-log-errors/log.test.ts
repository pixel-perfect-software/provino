jest.retryTimes(2, { logErrorsBeforeRetry: true })

const calls: Record<string, number> = {}

/** A test body that fails its first `failures` calls with `<name> failed #<call>`. */
function flaky(name: string, failures: number): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    if (calls[name] <= failures) throw new Error(`${name} failed #${calls[name]}`)
  }
}

test('passes on the third attempt', flaky('third', 2))
test('fails every attempt', flaky('every', 99))
