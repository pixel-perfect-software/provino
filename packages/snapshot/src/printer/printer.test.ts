import { describe, expect, it } from 'provino'
import { nativeSnapshotPrinter } from './impl.ts'

interface OracleModule {
  format(value: unknown, options: object): string
  plugins: Record<string, unknown>
}

let oracleModule: Promise<OracleModule> | undefined
// The installed pretty-format is the oracle; it loads when the first test needs it, not at import.
const oracle = (): Promise<OracleModule> => {
  oracleModule ??= import('pretty-format') as unknown as Promise<OracleModule>
  return oracleModule
}

interface MockLike {
  _isMockFunction: true
  getMockName(): string
  mock: { calls: unknown[][]; results: unknown[] }
}

// A mock function the way Jest's mock serializer reads it (jest-snapshot `mockSerializer.ts`).
const mockLike = {
  test: (val: unknown): boolean =>
    typeof val === 'function' && (val as Partial<MockLike>)._isMockFunction === true,
  serialize: (
    val: MockLike,
    config: { indent: string; spacingOuter: string; min: boolean },
    indentation: string,
    depth: number,
    refs: unknown,
    printer: (v: unknown, c: unknown, i: string, d: number, r: unknown) => string,
  ): string => {
    const name = val.getMockName()
    const nameString = name === 'jest.fn()' ? '' : ` ${name}`
    let callsString = ''
    if (val.mock.calls.length > 0) {
      const next = indentation + config.indent
      callsString = ` {${config.spacingOuter}${next}"calls": ${printer(val.mock.calls, config, next, depth, refs)}${config.min ? ', ' : ','}${config.spacingOuter}${next}"results": ${printer(val.mock.results, config, next, depth, refs)}${config.min ? '' : ','}${config.spacingOuter}${indentation}}`
    }
    return `[MockFunction${nameString}]${callsString}`
  },
}

/** The oracle's side of `serialize`: Jest's built-in plugin order and defaults. */
async function expected(value: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  const { format, plugins } = await oracle()
  return format(value, {
    escapeRegex: true,
    indent: 2,
    printFunctionName: false,
    plugins: [
      plugins.ReactTestComponent,
      plugins.ReactElement,
      plugins.DOMElement,
      plugins.DOMCollection,
      plugins.Immutable,
      mockLike,
      plugins.AsymmetricMatcher,
    ],
    ...extra,
  } as never)
}

function mockFunction(name: string, calls: unknown[][]): unknown {
  const fn = (): void => {}
  return Object.assign(fn, {
    _isMockFunction: true,
    getMockName: () => name,
    mock: { calls, results: calls.map(() => ({ type: 'return', value: undefined })) },
  })
}

class Point {
  x = 1
  y = 2
}

const reactElement = (type: unknown, props: Record<string, unknown>, tag: string): unknown => ({
  $$typeof: Symbol.for(tag),
  type,
  key: null,
  ref: null,
  props,
})

function domElement(name: string, tagName: string, attributes: Record<string, string>): unknown {
  const Stub = { [name]: class {} }[name] as new () => object
  return Object.assign(new Stub(), {
    nodeType: 1,
    tagName,
    attributes: Object.entries(attributes).map(([k, v]) => ({ name: k, value: v })),
    childNodes: [],
  })
}

const asymmetric = (name: string, sample: unknown): unknown => ({
  $$typeof: Symbol.for('jest.asymmetricMatcher'),
  asymmetricMatch: () => true,
  toAsymmetricMatcher: () => name,
  toString: () => name,
  getExpectedType: () => 'object',
  sample,
  inverse: false,
})

function circular(): unknown {
  const o: Record<string, unknown> = { n: 1 }
  o['self'] = o
  return o
}

const table: ReadonlyArray<readonly [string, () => unknown]> = [
  ['a string with escapes', () => 'say "hi"\n\t\\ back\x00slash'],
  ['a multi-line string', () => 'a\nb\nc'],
  ['numbers', () => [0, -0, 1.5, Number.NaN, Infinity, 10n]],
  ['undefined, null and symbols', () => [undefined, null, Symbol('s'), Symbol.for('x')]],
  ['a nested object with sorted keys', () => ({ b: 1, a: { d: [1, 2], c: 'x' } })],
  [
    'a Map and a Set',
    () => ({
      map: new Map<unknown, unknown>([
        ['a', 1],
        [{ k: 1 }, new Set([1, 2])],
      ]),
      set: new Set(['x']),
    }),
  ],
  [
    'a class instance and a null prototype',
    () => [new Point(), Object.assign(Object.create(null), { z: 1 })],
  ],
  ['a circular reference', circular],
  [
    'a Date, RegExp, Error and functions',
    () => [new Date(0), /a+\/b/gi, new RangeError('bad'), function named() {}, () => {}],
  ],
  [
    'typed arrays and buffers',
    () => [new Uint8Array([1, 2, 3]), new ArrayBuffer(2), Buffer.from('ab')],
  ],
  ['boxed values', () => [new Number(3), new String('s')]],
  ['a mock function without calls', () => mockFunction('jest.fn()', [])],
  ['a named mock function with calls', () => mockFunction('getUser', [[1, 'a'], [2]])],
  [
    'a React 18 element tree',
    () =>
      reactElement(
        'div',
        {
          className: 'a',
          children: [reactElement('span', { children: 'hi' }, 'react.element'), 'text'],
        },
        'react.element',
      ),
  ],
  [
    'a React 19 element',
    () => reactElement('p', { id: 'x', children: 'hello' }, 'react.transitional.element'),
  ],
  [
    'a React fragment',
    () => reactElement(Symbol.for('react.fragment'), { children: ['a', 'b'] }, 'react.element'),
  ],
  [
    'a react-test-renderer component',
    () => ({
      $$typeof: Symbol.for('react.test.json'),
      type: 'div',
      props: { a: 1 },
      children: ['x'],
    }),
  ],
  ['a DOM-like element', () => domElement('HTMLDivElement', 'DIV', { id: 'a', class: 'b' })],
  [
    'asymmetric matchers',
    () => [asymmetric('Anything', undefined), { v: asymmetric('Any', Number) }],
  ],
]

describe('the native snapshot printer', () => {
  for (const [name, make] of table) {
    it(`prints ${name} as the installed pretty-format does`, async () => {
      const value = make()
      expect(nativeSnapshotPrinter().serialize(value, { format: {}, plugins: [] })).toBe(
        await expected(value),
      )
    })
  }

  it('applies the format options a dialect sets, over the defaults', async () => {
    const value = { s: 'a"b', n: [1, 2] }
    const format = { escapeString: false, printBasicPrototype: false, indent: 4 }
    expect(nativeSnapshotPrinter().serialize(value, { format, plugins: [] })).toBe(
      await expected(value, format),
    )
  })

  it('tries a project serializer before the built-ins', () => {
    const plugin = { test: (v: unknown): boolean => v === 7, serialize: (): string => 'seven' }
    expect(nativeSnapshotPrinter().serialize(7, { format: {}, plugins: [plugin] })).toBe('seven')
  })

  it('has no runner name in its words', () => {
    const info = {
      matcherName: 'toMatchSnapshot',
      isInline: false,
      hint: 'h',
      currentTestName: 'a test',
      key: 'a test: h 1',
      count: 1,
      expand: false,
      expected: 'x',
      actual: 'y',
      received: 'y',
    }
    const { messages } = nativeSnapshotPrinter()
    const texts = [
      messages.mismatch(info),
      messages.notWritten(info),
      messages.propertiesMismatch(info),
      messages.noInlineFrame?.().message ?? '',
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/jest|vitest/i)
    }
    expect(messages.mismatch(info)).toContain('Snapshot name: `a test: h 1`')
  })
})
