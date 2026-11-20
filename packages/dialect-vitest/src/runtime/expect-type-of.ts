// `expectTypeOf` at run time: `vitest` re-exports `expect-type` 1.4.0's, whose checks are all
// types. When it runs, every assertion returns `true`; the members that move to another type
// return a new object of the same shape. Provino's own code over the same member names (speed: no
// dependency for a function that checks nothing).

const pass = (): boolean => true

const ASSERTIONS: readonly string[] = [
  'toBeAny',
  'toBeUnknown',
  'toBeNever',
  'toBeFunction',
  'toBeObject',
  'toBeArray',
  'toBeString',
  'toBeNumber',
  'toBeBoolean',
  'toBeVoid',
  'toBeSymbol',
  'toBeNull',
  'toBeUndefined',
  'toBeNullable',
  'toBeBigInt',
  'toMatchTypeOf',
  'toEqualTypeOf',
  'toBeConstructibleWith',
  'toMatchObjectType',
  'toExtend',
]

const MOVES: readonly string[] = [
  'map',
  'toBeCallableWith',
  'extract',
  'exclude',
  'pick',
  'omit',
  'toHaveProperty',
  'parameter',
]

const GETTERS: readonly string[] = [
  'parameters',
  'returns',
  'resolves',
  'not',
  'items',
  'constructorParameters',
  'thisParameter',
  'instance',
  'guards',
  'asserts',
]

function branded(): object {
  return { inspect: pass, configure: branded, toEqualTypeOf: pass }
}

/**
 * `expectTypeOf(value)`: type assertions, which pass at run time.
 * @public
 */
export function expectTypeOf(_value?: unknown): Record<string, unknown> {
  const object: Record<string, unknown> = {}
  for (const name of ASSERTIONS) object[name] = pass
  for (const name of MOVES) object[name] = expectTypeOf
  Object.defineProperty(object, 'branded', { get: branded, enumerable: true, configurable: true })
  for (const name of GETTERS) {
    Object.defineProperty(object, name, { get: () => expectTypeOf({}), configurable: true })
  }
  return object
}
