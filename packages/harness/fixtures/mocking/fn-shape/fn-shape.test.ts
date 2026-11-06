// What a mock function looks like from outside: names, keys, statics, identity.
const M = typeof jest === 'undefined' ? vi : jest
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
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
