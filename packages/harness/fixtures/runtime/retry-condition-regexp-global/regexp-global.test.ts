const calls: Record<string, number> = {}

/** A test body that fails its first `failures` calls with `boom` and traces each call. */
function failing(name: string, failures = Number.POSITIVE_INFINITY): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    if (calls[name] <= failures) throw new Error('boom')
  }
}

const shared = /boom/g

test('no flag', { retry: { count: 3, condition: /boom/ } }, failing('no flag'))

test('global flag', { retry: { count: 3, condition: /boom/g } }, failing('global flag'))

test('sticky flag', { retry: { count: 3, condition: /boom/y } }, failing('sticky flag'))

test(
  'shared global, passes on the retry',
  { retry: { count: 3, condition: shared } },
  failing('shared first', 1),
)

test('shared global, next test', { retry: { count: 3, condition: shared } }, failing('shared next'))
