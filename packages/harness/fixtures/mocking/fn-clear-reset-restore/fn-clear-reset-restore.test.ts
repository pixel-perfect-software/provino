// mockClear, mockReset, mockRestore and the three *AllMocks on a mock function.
const M = typeof jest === 'undefined' ? vi : jest
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('mockClear returns the mock, drops the records and keeps the implementation', () => {
  const f = M.fn(() => 'impl')
  f.mockReturnValueOnce('once')
  f('a')
  const returned = f.mockClear()
  const afterClear = { calls: f.mock.calls.length, results: f.mock.results.length }
  return { returnsSelf: returned === f, afterClear, next: f(), after: f() }
})

c('mockClear keeps or replaces the mock object and its arrays', () => {
  const f = M.fn()
  f(1)
  const object = f.mock
  const calls = f.mock.calls
  f.mockClear()
  return { sameObject: f.mock === object, sameCallsArray: f.mock.calls === calls, oldCalls: calls }
})

c('mockReset on a mock of an implementation', () => {
  const f = M.fn(() => 'impl')
  f('a')
  const returned = f.mockReset()
  const callsAfterReset = f.mock.calls.length
  return { returnsSelf: returned === f, callsAfterReset, value: f() }
})

c('mockReset drops a return value and the once queue', () => {
  const f = M.fn()
  f.mockReturnValue('fixed').mockReturnValueOnce('once')
  f.mockReset()
  return [f(), f()]
})

c('mockRestore on a mock of an implementation', () => {
  const f = M.fn(() => 'impl')
  f('a')
  f.mockRestore()
  const callsAfterRestore = f.mock.calls.length
  return { callsAfterRestore, value: f() }
})

c('clearAllMocks clears the records of a mock of an implementation and keeps its behaviour', () => {
  const f = M.fn(() => 'impl')
  f.mockReturnValueOnce('once')
  f('a')
  M.clearAllMocks()
  const callsAfterClear = f.mock.calls.length
  return { callsAfterClear, next: f(), after: f() }
})

c('resetAllMocks on a mock of an implementation', () => {
  const f = M.fn(() => 'impl')
  f('a')
  M.resetAllMocks()
  return { calls: f.mock.calls.length, value: f() }
})

c('restoreAllMocks leaves a mock of an implementation untouched', () => {
  const f = M.fn(() => 'impl')
  f.mockReturnValue('fixed')
  f('a')
  M.restoreAllMocks()
  return { calls: f.mock.calls.length, value: f() }
})

c('mock keeps its identity across clearAllMocks on a mock that was never called', () => {
  const f = M.fn()
  const before = f.mock
  M.clearAllMocks()
  return { sameObject: f.mock === before }
})

c('mock keeps or loses its identity across clearAllMocks on a called mock', () => {
  const f = M.fn()
  f()
  const before = f.mock
  M.clearAllMocks()
  return { sameObject: f.mock === before, calls: f.mock.calls.length }
})

c('mockReset also clears the records', () => {
  const f = M.fn()
  f(1)
  f.mockReset()
  return { calls: f.mock.calls, results: f.mock.results, order: f.mock.invocationCallOrder }
})
