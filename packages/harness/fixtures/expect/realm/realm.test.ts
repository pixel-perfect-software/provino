// Spike C's realm cases, rebuilt (Track 7 F4): 18 assertions on values made in another realm (a
// `vm` context, as the `realm` isolation tier gives each file), each its own test. The values are
// equal to the ones made here, so a runner that reads the constructor or `instanceof` rather than
// the value's class fails some of them: Vitest does, on `toStrictEqual`, Map, Set,
// `expect.any(Array)` and a strict Error.
const vm = process.getBuiltinModule('node:vm')
const there = (code: string): never => vm.runInNewContext(code)

describe('toEqual across realms', () => {
  test('01 an array', () => {
    expect(there('[1, [2, 3]]')).toEqual([1, [2, 3]])
  })
  test('02 an object', () => {
    expect(there('({ a: 1, b: { c: [2] } })')).toEqual({ a: 1, b: { c: [2] } })
  })
  test('03 a Map', () => {
    expect(there('new Map([["k", { n: 1 }]])')).toEqual(new Map([['k', { n: 1 }]]))
  })
  test('04 a Set', () => {
    expect(there('new Set([1, 2])')).toEqual(new Set([1, 2]))
  })
  test('05 a Date', () => {
    expect(there('new Date(1000)')).toEqual(new Date(1000))
  })
  test('06 a RegExp', () => {
    expect(there('/a+b/gi')).toEqual(/a+b/gi)
  })
  test('07 an Error', () => {
    expect(there('new Error("same")')).toEqual(new Error('same'))
  })
  test('08 a typed array', () => {
    expect(there('new Uint8Array([1, 2])')).toEqual(new Uint8Array([1, 2]))
  })
  test('09 an object holding a Map and an Error', () => {
    expect(there('({ m: new Map([[1, 2]]), e: new TypeError("t") })')).toEqual({
      m: new Map([[1, 2]]),
      e: new TypeError('t'),
    })
  })
})

describe('toStrictEqual across realms', () => {
  test('10 an array', () => {
    expect(there('[1, 2]')).toStrictEqual([1, 2])
  })
  test('11 an object', () => {
    expect(there('({ a: 1 })')).toStrictEqual({ a: 1 })
  })
  test('12 a Map', () => {
    expect(there('new Map([["k", 1]])')).toStrictEqual(new Map([['k', 1]]))
  })
  test('13 a Set', () => {
    expect(there('new Set([1])')).toStrictEqual(new Set([1]))
  })
  test('14 an Error', () => {
    expect(there('new RangeError("r")')).toStrictEqual(new RangeError('r'))
  })
})

describe('asymmetric matchers across realms', () => {
  test('15 expect.any(Array) against an array', () => {
    expect(there('[1]')).toEqual(expect.any(Array))
  })
  test('16 expect.any(Object) against an object', () => {
    expect(there('({})')).toEqual(expect.any(Object))
  })
  test('17 expect.any(Function) against a function', () => {
    expect(there('(function f() {})')).toEqual(expect.any(Function))
  })
  test('18 expect.objectContaining against an object', () => {
    expect(there('({ a: 1, b: 2 })')).toEqual(expect.objectContaining({ a: 1 }))
  })
})
