// What only Jest 30.5 has: whenCalledWith, replaceProperty and replaceValue.
const attempt = (run: () => unknown) => {
  try {
    return { value: run() }
  } catch (error) {
    return { threw: error }
  }
}
const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('whenCalledWith routes a call by its arguments and falls through otherwise', () => {
  const f = jest.fn(() => 'fallback')
  f.whenCalledWith(1).mockReturnValue('one')
  f.whenCalledWith(2, 'b').mockReturnValue('two')
  return { one: f(1), two: f(2, 'b'), other: f(3), partial: f(2), calls: f.mock.calls.length }
})

c('whenCalledWith on a mock with no implementation, and its sub-mock records', () => {
  const f = jest.fn()
  const sub = f.whenCalledWith('x')
  sub.mockReturnValue('routed')
  return { hit: f('x'), miss: f('y'), subCalls: sub.mock.calls, ownCalls: f.mock.calls.length }
})

c('replaceProperty swaps a value and replaceValue swaps it again', () => {
  const target = { setting: 'original' }
  const replaced = jest.replaceProperty(target, 'setting', 'first')
  const first = target.setting
  const returned = replaced.replaceValue('second')
  return {
    first,
    second: target.setting,
    replaceValueReturnsSelf: returned === replaced,
    keys: Object.keys(replaced),
  }
})

c('restore puts the original value back, and an own property stays own', () => {
  const target = { setting: 'original' }
  const replaced = jest.replaceProperty(target, 'setting', 'temporary')
  const restoreReturns = replaced.restore()
  return { value: target.setting, restoreReturns, own: Object.hasOwn(target, 'setting') }
})

c('replaceProperty on an inherited property, restored by deleting the own copy', () => {
  const base = { inherited: 'base' }
  const target = Object.create(base)
  const replaced = jest.replaceProperty(target, 'inherited', 'shadow')
  const during = { value: target.inherited, own: Object.hasOwn(target, 'inherited') }
  replaced.restore()
  return { during, after: { value: target.inherited, own: Object.hasOwn(target, 'inherited') } }
})

c(
  'replacing the same property twice reuses the replacement, and restoreAllMocks restores it',
  () => {
    const target = { setting: 'original' }
    const first = jest.replaceProperty(target, 'setting', 'a')
    const second = jest.replaceProperty(target, 'setting', 'b')
    const sameReplaced = first === second
    const replacedValue = target.setting
    jest.restoreAllMocks()
    return { sameReplaced, replacedValue, afterRestoreAll: target.setting }
  },
)

c('replaceProperty on a primitive', () =>
  attempt(() => jest.replaceProperty(1 as never, 'a' as never, 1 as never)),
)

c('replaceProperty on a property that does not exist', () =>
  attempt(() => jest.replaceProperty({} as { a?: number }, 'a', 1)),
)

c('replaceProperty on a getter', () =>
  attempt(() =>
    jest.replaceProperty(
      {
        get a() {
          return 1
        },
      },
      'a',
      2,
    ),
  ),
)

c('replaceProperty on a function', () =>
  attempt(() => jest.replaceProperty({ a: () => 1 }, 'a', () => 2)),
)
