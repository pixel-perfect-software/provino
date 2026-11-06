// What a mock function does when called: implementations, return values, once queues and
// withImplementation.
const M = typeof jest === 'undefined' ? vi : jest
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}
const attempt = (run: () => unknown) => {
  try {
    return { value: run() }
  } catch (error) {
    return { threw: error }
  }
}
const settle = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ resolved: value }),
    (error) => ({ rejected: error }),
  )

c('mockImplementation replaces the default and returns the mock', () => {
  const f = M.fn(() => 'first')
  const returned = f.mockImplementation(() => 'second')
  return { value: f(), returnsSelf: returned === f }
})

c('mockReturnValue wins over the implementation, and returns the mock', () => {
  const f = M.fn(() => 'impl')
  const returned = f.mockReturnValue('fixed')
  return { value: f(), returnsSelf: returned === f }
})

c('mockReturnValueOnce values are used in order, then the default', () => {
  const f = M.fn(() => 'default')
  f.mockReturnValueOnce('one').mockReturnValueOnce('two')
  return [f(), f(), f(), f()]
})

c('a once queue mixes implementations and values in the order they were queued', () => {
  const f = M.fn(() => 'default')
  f.mockImplementationOnce(() => 'impl once')
  f.mockReturnValueOnce('value once')
  f.mockImplementationOnce(() => 'impl once again')
  return [f(), f(), f(), f()]
})

c('mockResolvedValue and mockResolvedValueOnce', async () => {
  const f = M.fn()
  f.mockResolvedValue('always').mockResolvedValueOnce('once')
  return [await f(), await f(), await f()]
})

c('mockRejectedValue and mockRejectedValueOnce', async () => {
  const f = M.fn()
  f.mockRejectedValue(new Error('always')).mockRejectedValueOnce(new Error('once'))
  return [await settle(f()), await settle(f()), await settle(f())]
})

c('mockReturnThis returns the receiver', () => {
  const owner = { f: M.fn() }
  owner.f.mockReturnThis()
  return { returnsOwner: owner.f() === owner }
})

c('withImplementation runs a callback with a temporary implementation', () => {
  const f = M.fn(() => 'original')
  let inside: unknown
  const returned = f.withImplementation(
    () => 'temporary',
    () => {
      inside = f()
    },
  )
  return { inside, after: f(), returnIsMock: returned === f, returnType: typeof returned }
})

c('withImplementation with an async callback restores after it settles', async () => {
  const f = M.fn(() => 'original')
  let inside: unknown
  const returned = f.withImplementation(
    () => 'temporary',
    async () => {
      inside = f()
      await Promise.resolve()
    },
  )
  const isPromise = typeof (returned as { then?: unknown } | undefined)?.then === 'function'
  const duringAwait = f()
  const settled = await returned
  return { inside, isPromise, duringAwait, after: f(), settledIsMock: settled === f }
})

c('withImplementation when the callback throws', () => {
  const f = M.fn(() => 'original')
  f.mockImplementationOnce(() => 'queued')
  let error: unknown
  try {
    f.withImplementation(
      () => 'temporary',
      () => {
        throw new Error('callback failed')
      },
    )
  } catch (caught) {
    error = caught
  }
  return { error, next: f(), after: f() }
})

c('getMockImplementation returns the persistent implementation, or a queued one first', () => {
  const persistent = () => 'persistent'
  const queued = () => 'queued'
  const f = M.fn(persistent)
  const before = f.getMockImplementation() === persistent
  f.mockImplementationOnce(queued)
  const withQueued = f.getMockImplementation()
  return {
    before,
    withQueuedIsPersistent: withQueued === persistent,
    withQueuedIsQueued: withQueued === queued,
  }
})

c('getMockImplementation of a bare mock', () => M.fn().getMockImplementation())

c('the settled shorthands return a promise, not the bare value', () => {
  const promiseOf = (value: unknown) => {
    // A rejected promise nobody handles would fail the run.
    ;(value as Promise<unknown>).catch?.(() => {})
    return {
      thenType: typeof (value as { then?: unknown } | undefined)?.then,
      tag: Object.prototype.toString.call(value),
    }
  }
  const resolved = M.fn().mockResolvedValue('v')
  const resolvedOnce = M.fn().mockResolvedValueOnce('v')
  const rejected = M.fn().mockRejectedValue(new Error('r'))
  const rejectedOnce = M.fn().mockRejectedValueOnce(new Error('r'))
  return {
    mockResolvedValue: promiseOf(resolved()),
    mockResolvedValueOnce: promiseOf(resolvedOnce()),
    mockRejectedValue: promiseOf(rejected()),
    mockRejectedValueOnce: promiseOf(rejectedOnce()),
  }
})

c('mockImplementationOnce(undefined) after mockReturnValue', () => {
  const f = M.fn()
  f.mockReturnValue(7)
  f.mockImplementationOnce(undefined as never)
  return attempt(() => [f(), f(), f()])
})

c('mockImplementationOnce(undefined) under new', () => {
  const f = M.fn()
  f.mockReturnValue({ seven: 7 })
  f.mockImplementationOnce(undefined as never)
  return attempt(() => [typeof new f(), typeof new f(), typeof new f()])
})

c('mockImplementation(undefined) on a mock with an implementation', () => {
  const f = M.fn(() => 'impl')
  f.mockReturnValue('value')
  f.mockImplementation(undefined as never)
  return attempt(() => [f(), f.getMockImplementation() === undefined])
})

c('mockReset inside a withImplementation callback', () => {
  const f = M.fn(() => 'original')
  let inside: unknown
  f.withImplementation(
    () => 'temporary',
    () => {
      f.mockReset()
      inside = f()
    },
  )
  return { inside, after: f() }
})

c('mockReset while an async withImplementation callback is pending', async () => {
  const f = M.fn(() => 'original')
  let inside: unknown
  const pending = f.withImplementation(
    () => 'temporary',
    async () => {
      await Promise.resolve()
      inside = f()
    },
  )
  f.mockReset()
  const during = f()
  await pending
  return { inside, during, after: f() }
})

c('a later mockImplementation replaces an earlier mockReturnValue', () => {
  const f = M.fn()
  f.mockReturnValue('value')
  f.mockImplementation(() => 'impl')
  return f()
})
