const calls: Record<string, number> = {}

/** A test body that fails every call with `message` and traces each call. */
function failing(name: string, message: string): () => void {
  return () => {
    calls[name] = (calls[name] ?? 0) + 1
    trace(`${name} #${calls[name]}`)
    throw new Error(message)
  }
}

test(
  'function says yes',
  {
    retry: {
      count: 2,
      condition: (error) => {
        trace(`condition asked: ${error.message}`)
        return true
      },
    },
  },
  failing('function says yes', 'always'),
)

test(
  'function says no',
  { retry: { count: 2, condition: () => false } },
  failing('function says no', 'never retried'),
)
