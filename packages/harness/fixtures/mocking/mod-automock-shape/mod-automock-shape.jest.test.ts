import * as shapes from './shapes.ts'

jest.mock('./shapes.ts')

const c = (id: string, run: () => unknown) => {
  test(id, () => observe(id, run))
}

c('a function export becomes a mock that returns undefined', () => {
  const result = shapes.fn(1)
  return {
    result,
    isMock: jest.isMockFunction(shapes.fn),
    calls: (shapes.fn as unknown as jest.Mock).mock.calls,
    name: shapes.fn.name,
  }
})

c(
  'a class becomes a constructor mock whose body never runs, with per-instance method mocks',
  () => {
    const instance = new shapes.Klass()
    const other = new shapes.Klass()
    const methodResult = instance.method()
    other.method()
    const protoMethod = shapes.Klass.prototype.method as unknown as jest.Mock
    return {
      isMock: jest.isMockFunction(shapes.Klass),
      field: instance.field,
      methodResult,
      ownMethod: Object.hasOwn(instance, 'method'),
      instanceMethodIsProto: instance.method === shapes.Klass.prototype.method,
      instanceMethodCalls: (instance.method as unknown as jest.Mock).mock.calls.length,
      protoMethodCalls: protoMethod.mock.calls.length,
      constructorCalls: (shapes.Klass as unknown as jest.Mock).mock.calls.length,
      instances: (shapes.Klass as unknown as jest.Mock).mock.instances.length,
      instanceofKlass: instance instanceof shapes.Klass,
    }
  },
)

c('statics, nested objects and getters are mocked; getters return undefined', () => ({
  staticCall: shapes.Klass.make(),
  staticIsMock: jest.isMockFunction(shapes.Klass.make),
  staticValue: shapes.Klass.staticValue,
  deepCall: shapes.nested.deep.call(),
  deepIsMock: jest.isMockFunction(shapes.nested.deep.call),
  deepValue: shapes.nested.deep.value,
  label: shapes.nested.label,
  getter: shapes.nested.computed,
  accessor: new shapes.Klass().accessor,
}))

c('arrays become empty, Maps and primitives and null are kept', () => ({
  list: shapes.list,
  isArray: Array.isArray(shapes.list),
  map: shapes.map,
  text: shapes.text,
  count: shapes.count,
  flag: shapes.flag,
  nothing: shapes.nothing,
}))

c('a subclass instance is not an instance of the mocked base', () => {
  const sub = new shapes.Sub()
  return {
    subInstanceofSub: sub instanceof shapes.Sub,
    subInstanceofKlass: sub instanceof shapes.Klass,
    extra: sub.extra(),
  }
})

c(
  'the module object itself: an __esModule key, and what happens to RegExp, Date and BigInt',
  () => {
    const raw = require('./shapes.ts') as Record<string, unknown>
    return {
      esModule: raw.__esModule,
      keys: Object.keys(raw),
      pattern: raw.pattern,
      when: raw.when,
      big: raw.big,
    }
  },
)
