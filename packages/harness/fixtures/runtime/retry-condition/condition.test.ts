const calls: Record<string, number> = {}

/** A test body that fails every call with `message` and traces each call. */
function failing(name: string, message: string): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    throw new Error(message)
  }
}

/** Fails with `first`, then with `second` on every later call. */
function changing(name: string, first: string, second: string): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    throw new Error(calls[name] === 1 ? first : second)
  }
}

test(
  'regexp matches',
  { retry: { count: 2, condition: /transient/ } },
  failing('regexp matches', 'a transient failure'),
)

test(
  'regexp does not match',
  { retry: { count: 2, condition: /transient/ } },
  failing('regexp does not match', 'a permanent failure'),
)

test(
  'the last error decides',
  { retry: { count: 2, condition: /transient/ } },
  changing('the last error decides', 'transient at first', 'permanent after'),
)
