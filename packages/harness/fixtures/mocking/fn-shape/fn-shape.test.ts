// What a mock function looks like from outside: names, keys, statics, identity.
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

c('name of a bare mock, of a mock of a named function, and of a mock of an arrow', () => {
  function named() {}
  const arrow = () => {}
  return { bare: M.fn().name, named: M.fn(named).name, arrow: M.fn(arrow).name }
})

c('getMockName defaults, and mockName sets it and returns the mock', () => {
  const f = M.fn()
  const before = f.getMockName()
  const returned = f.mockName('my mock')
  return { before, after: f.getMockName(), returnsSelf: returned === f }
})

c('getMockName of a mock of a named function', () => {
  function named() {}
  return M.fn(named).getMockName()
})

c('keys of mock before the first call', () => Object.keys(M.fn().mock))

c('keys of mock after the first call', () => {
  const f = M.fn()
  f()
  return Object.keys(f.mock)
})

c('mock is an own enumerable property', () => {
  const f = M.fn()
  const descriptor = Object.getOwnPropertyDescriptor(f, 'mock')
  return {
    own: descriptor !== undefined,
    enumerable: descriptor?.enumerable,
    isAccessor: descriptor === undefined ? undefined : 'get' in descriptor,
  }
})

c('Object.keys of a mock function', () => Object.keys(M.fn()))

c('isMockFunction on a mock, a plain function and a lookalike object', () => ({
  mock: M.isMockFunction(M.fn()),
  plain: M.isMockFunction(() => {}),
  lookalike: M.isMockFunction({ _isMockFunction: true }),
  nothing: M.isMockFunction(undefined),
}))

c('fn of an existing mock is the same mock or a wrapper', () => {
  const inner = M.fn(() => 'inner')
  const outer = M.fn(inner)
  outer('x')
  return { same: outer === inner, outerCalls: outer.mock.calls, innerCalls: inner.mock.calls }
})

c('static properties of the implementation', () => {
  const impl = Object.assign(() => 1, { extra: 'static' })
  return { extra: M.fn(impl).extra, hasOwn: Object.hasOwn(M.fn(impl), 'extra') }
})

c('assigning to mock', () => {
  const f = M.fn()
  const replacement = { calls: [['fake']] }
  let error: string | undefined
  try {
    f.mock = replacement
  } catch (caught) {
    // Only the class: Vitest's message prints the mock's own source.
    error = (caught as Error).name
  }
  return { error, replaced: f.mock === replacement, calls: f.mock.calls }
})

c(
  'length of a mock of a function with two parameters',
  () => M.fn((a: number, b: number) => a + b).length,
)

c('a method taken off its mock still works on that mock', () => {
  const f = M.fn()
  f('a')
  const { mockClear, mockReturnValue } = f
  const before = f.mock.calls.length
  mockClear()
  mockReturnValue('detached')
  return { before, after: f.mock.calls.length, value: f() }
})

c('a method read twice is the same function', () => {
  const f = M.fn()
  const clearFirst = f.mockClear
  const clearSecond = f.mockClear
  const returnFirst = f.mockReturnValue
  const returnSecond = f.mockReturnValue
  return { mockClear: clearFirst === clearSecond, mockReturnValue: returnFirst === returnSecond }
})

c('assigning to a method replaces it for that mock', () => {
  const f = M.fn()
  const replacement = () => 'replacement'
  const result = attempt(() => {
    ;(f as { mockClear: unknown }).mockClear = replacement
  })
  return { result, identity: f.mockClear === replacement, other: M.fn().mockClear === replacement }
})

c('length of a method, read off the mock and taken off it', () => {
  const f = M.fn()
  const { mockReturnValue } = f
  return { onMock: f.mockReturnValue.length, detached: mockReturnValue.length }
})

c('a bound mock is not a mock function', () => {
  const bound = M.fn().bind(null)
  return {
    isMockFunction: M.isMockFunction(bound),
    flag: (bound as { _isMockFunction?: unknown })._isMockFunction,
  }
})
