// spyOn on a method: install, call-through, reset, restore, names, inherited methods, errors.
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
const make = () => ({
  m(a: string) {
    return `original:${a}`
  },
})

c('spyOn installs a mock that calls through', () => {
  const target = make()
  const original = target.m
  const spy = M.spyOn(target, 'm')
  return {
    installed: target.m === spy,
    isMock: M.isMockFunction(spy),
    value: target.m('x'),
    calls: spy.mock.calls,
    results: spy.mock.results,
    originalDiffers: original !== spy,
  }
})

c('a spy with a return value stops calling through', () => {
  const target = make()
  const spy = M.spyOn(target, 'm')
  spy.mockReturnValue('stubbed')
  return target.m('x')
})

c('mockReset on a spy keeps it installed', () => {
  const target = make()
  const spy = M.spyOn(target, 'm')
  spy.mockReturnValue('stubbed')
  target.m('a')
  const returned = spy.mockReset()
  const callsAfterReset = spy.mock.calls.length
  return {
    installed: target.m === spy,
    returnsSelf: returned === spy,
    callsAfterReset,
    value: target.m('b'),
  }
})

c('mockRestore on a spy puts the original back', () => {
  const target = make()
  const original = target.m
  const spy = M.spyOn(target, 'm')
  spy.mockReturnValue('stubbed')
  spy.mockRestore()
  const callsAfterRestore = spy.mock.calls.length
  return {
    restored: target.m === original,
    callsAfterRestore,
    value: target.m('x'),
    spyValue: spy('y'),
  }
})

c('resetAllMocks on a spy keeps it installed', () => {
  const target = make()
  const spy = M.spyOn(target, 'm')
  spy.mockReturnValue('stubbed')
  M.resetAllMocks()
  return { installed: target.m === spy, value: target.m('x') }
})

c('restoreAllMocks restores a spy and keeps its state and implementation', () => {
  const target = make()
  const original = target.m
  const spy = M.spyOn(target, 'm')
  spy.mockReturnValue('stubbed')
  target.m('a')
  M.restoreAllMocks()
  return {
    restored: target.m === original,
    calls: spy.mock.calls.length,
    value: target.m('x'),
    spyValue: spy('y'),
  }
})

c('clearAllMocks clears a spy and keeps it installed', () => {
  const target = make()
  const spy = M.spyOn(target, 'm')
  target.m('a')
  M.clearAllMocks()
  return { installed: target.m === spy, calls: spy.mock.calls.length, value: target.m('b') }
})

c('getMockName of a spy', () => M.spyOn(make(), 'm').getMockName())

c('getMockImplementation of a spy', () => {
  const spy = M.spyOn(make(), 'm')
  const implementation = spy.getMockImplementation()
  return { type: typeof implementation, value: attempt(() => implementation?.('z')) }
})

c('spyOn a constructor on a namespace object, then new', () => {
  const ns = {
    Klass: class {
      value = 'real'
    },
  }
  const spy = M.spyOn(ns, 'Klass')
  const instance = attempt(() => new ns.Klass())
  return { instance, calls: spy.mock.calls.length, instances: spy.mock.instances.length }
})

c('spying an inherited method defines an own property that restore deletes', () => {
  class Base {
    m() {
      return 'base'
    }
  }
  const child = new (class extends Base {})()
  const before = Object.hasOwn(child, 'm')
  const spy = M.spyOn(child, 'm')
  const during = Object.hasOwn(child, 'm')
  spy.mockRestore()
  return { before, during, after: Object.hasOwn(child, 'm'), value: child.m() }
})

c('a spy can be disposed through Symbol.dispose', () => {
  const target = make()
  const original = target.m
  const spy = M.spyOn(target, 'm')
  const dispose = (spy as { [Symbol.dispose]?: () => void })[Symbol.dispose]
  const type = typeof dispose
  attempt(() => dispose?.call(spy))
  return { type, restored: target.m === original }
})

c('spyOn a missing key', () =>
  attempt(() => M.spyOn(make() as { missing?: () => void }, 'missing' as never)),
)

c('spyOn a property that is not a function', () => attempt(() => M.spyOn({ a: 1 }, 'a' as never)))

c('spyOn something that is not an object', () =>
  attempt(() => M.spyOn(undefined as never, 'a' as never)),
)

c('spyOn the same method twice', () => {
  const target = make()
  const first = M.spyOn(target, 'm')
  const second = M.spyOn(target, 'm')
  return { same: first === second }
})
