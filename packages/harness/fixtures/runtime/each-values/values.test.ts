// Vitest's %s prints a Date with Date.prototype.toString, in the local time zone: pin it while the
// titles are made, so the golden doesn't depend on the machine that runs the fixture.
const originalTimeZone = process.env.TZ
process.env.TZ = 'UTC'

class Base {
  a = 1
  #hidden = 2
  get computed() {
    return 3
  }
  method() {
    return this.#hidden
  }
}
class Child extends Base {
  b = 'child'
}
class Empty {}
class WithToString {
  toString() {
    return 'custom toString'
  }
}
class Anonymous {}
Object.defineProperty(Anonymous, 'name', { value: '' })

const symbolKey = Symbol('key')
const cyclicObject: Record<string, unknown> = { name: 'cyclic' }
cyclicObject.self = cyclicObject
const cyclicArray: unknown[] = [1]
cyclicArray.push(cyclicArray)
const cyclicMap = new Map<string, unknown>()
cyclicMap.set('self', cyclicMap)
const errorWithoutStack = new Error('boom')
delete errorWithoutStack.stack
const typeErrorWithoutStack = new TypeError('bad type')
delete typeErrorWithoutStack.stack
const nullPrototype = Object.create(null)
nullPrototype.a = 1
// Methods, not function declarations (see each-tokens): `%o` prints a sloppy function's `arguments`.
const functionWithProps = Object.assign({ withProps() {} }.withProps, { extra: 1 })
const objectArguments = (function (..._args: unknown[]) {
  // biome-ignore lint/complexity/noArguments: an arguments object is the value under test
  return arguments
})(1, 2)

const values: unknown[] = [
  new Base(),
  new Child(),
  new Empty(),
  new WithToString(),
  new Anonymous(),
  { toString: () => 'own toString' },
  { toJSON: () => 'own toJSON' },
  { [Symbol.for('nodejs.util.inspect.custom')]: () => 'custom inspect' },
  {
    get getter() {
      return 1
    },
    plain: 2,
  },
  { [symbolKey]: 1, regular: 2 },
  { 'quoted-key': 1, 'two words': 2, 3: 'numeric', valid_id: 4 },
  { nested: { level2: { level3: { level4: { level5: 'deep' } } } } },
  [[[[[['deep']]]]]],
  [{ a: [{ b: [{ c: 1 }] }] }],
  cyclicObject,
  cyclicArray,
  cyclicMap,
  new Uint8Array([1, 2, 3]),
  new Float64Array([1.5, -0]),
  new ArrayBuffer(4),
  new DataView(new ArrayBuffer(2)),
  [new Number(1), new String('s'), new Boolean(false)],
  // biome-ignore lint/suspicious/noSparseArray: a hole is the value under test
  [1, , 3],
  new Array(3),
  errorWithoutStack,
  typeErrorWithoutStack,
  new Proxy({ proxied: true }, {}),
  new WeakMap(),
  new WeakSet(),
  nullPrototype,
  functionWithProps,
  objectArguments,
  { fn() {}, arrow: () => {}, nested: { named() {} } },
  [undefined, null],
  { inObject: Symbol('in object') },
  { undef: undefined, nul: null, nan: Number.NaN, negZero: -0, inf: Infinity },
  new Map([[{ key: 1 }, new Set([[1, 2]])]]),
  new Set([new Set([new Set([new Set([1])])])]),
  new Map([['a', { b: new Map([['c', [1, 2, { d: 3 }]]]) }]]),
  [new Date(0), { when: new Date(86400000) }],
  { re: /x/g, date: new Date(0), fn: () => {} },
  Object.assign([1, 2], { extra: 'prop' }),
  'a string',
  [''],
  [' '],
  ["it's", 'say "hi"', 'back`tick', 'back\\slash', 'tab\there'],
  { "it's": 'say "hi"' },
]

test.each(values.map((value) => [value]))('s=%s', () => {})
test.each(values.map((value) => [value]))('o=%o', () => {})
test.each(values.map((value) => [value]))('O=%O', () => {})
test.each(values.map((value) => [value]))('p=%p', () => {})
test.each(values.map((value) => [value]))('j=%j', () => {})
test.each(values.map((value) => ({ v: value })))('v=$v', () => {})
test.each(values.map((value) => ({ v: { w: value } })))('v.w=$v.w', () => {})
test.each(values.map((value) => [value, value]))('%s ~ %p', () => {})

if (originalTimeZone === undefined) delete process.env.TZ
else process.env.TZ = originalTimeZone
