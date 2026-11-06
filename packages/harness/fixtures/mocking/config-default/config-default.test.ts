// What per-test mock cleanup leaves of mocks made in test 1, seen in test 2: a mock of an
// implementation with a return value, a bare mock with a return value, and a spy.
const M = typeof jest === 'undefined' ? vi : jest
const target = { method: () => 'original' }
let withImpl: ReturnType<typeof M.fn>
let bare: ReturnType<typeof M.fn>
let spy: ReturnType<typeof M.fn>

test('test 1 makes the mocks and calls them', () => {
  withImpl = M.fn(() => 'orig')
  withImpl.mockReturnValue('x')
  withImpl('a')
  bare = M.fn()
  bare.mockReturnValue('bare')
  bare('b')
  spy = M.spyOn(target, 'method')
  spy.mockReturnValue('spied')
  target.method()
})

test('test 2 observes what is left', () =>
  observe('state in test 2', () => {
    const state = {
      withImpl: { calls: withImpl.mock.calls.length },
      bare: { calls: bare.mock.calls.length },
      spy: { installed: target.method === spy, calls: spy.mock.calls.length },
    }
    return {
      ...state,
      withImplValue: withImpl(),
      bareValue: bare(),
      spyValue: target.method(),
    }
  }))
