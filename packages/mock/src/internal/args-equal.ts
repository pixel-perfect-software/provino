// `whenCalledWith`'s equality. jest-mock uses `equals(a, b, [iterableEquality])` from
// @jest/expect-utils, which this package can't import (its only runtime dependency is
// `@provino/types`), so this answers what those two answer, and `@provino/dialect-jest`'s
// `when-called-with-equality.test.ts` compares the two over a table.
//
// Two stacks, as upstream has: one for objects, which starts again inside an iterable, and one for
// iterables, which carries through. Both detect a cycle back to a pair being compared.

interface AsymmetricLike {
  asymmetricMatch(other: unknown): boolean
}

interface Stacks {
  readonly a: object[]
  readonly b: object[]
}

type Keyed = Record<PropertyKey, unknown>

const toStringTag = (value: unknown): string => Object.prototype.toString.call(value)

function isAsymmetric(value: unknown): value is AsymmetricLike {
  if (value === null || value === undefined) return false
  const match = (value as Partial<AsymmetricLike>).asymmetricMatch
  return toStringTag(match) === '[object Function]'
}

/** Own enumerable string keys, then own enumerable symbols. */
function ownKeys(value: object): PropertyKey[] {
  const symbols = Object.getOwnPropertySymbols(value).filter(
    (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true,
  )
  return [...Object.keys(value), ...symbols]
}

function isIterable(value: object): boolean {
  return Boolean((value as { [Symbol.iterator]?: unknown })[Symbol.iterator])
}

function isNative(fn: unknown): boolean {
  return typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]')
}

/** Constructors differ: the same native class from another realm still counts as the same. */
function sameConstructor(a: object, b: object): boolean {
  if (a.constructor === b.constructor) return true
  if (a.constructor === null || a.constructor === undefined) return false
  if (b.constructor === null || b.constructor === undefined) return false
  return (
    a.constructor.name === b.constructor.name && isNative(a.constructor) && isNative(b.constructor)
  )
}

function setsEqual(a: Set<unknown>, b: Set<unknown>, iterables: Stacks): boolean {
  for (const value of a) {
    if (b.has(value)) continue
    let found = false
    for (const other of b) {
      if (eq(value, other, { a: [], b: [] }, iterables)) found = true
    }
    if (!found) return false
  }
  return true
}

function mapsEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>, iterables: Stacks): boolean {
  for (const [key, value] of a) {
    if (b.has(key) && eq(value, b.get(key), { a: [], b: [] }, iterables)) continue
    let found = false
    for (const [otherKey, otherValue] of b) {
      if (
        eq(key, otherKey, { a: [], b: [] }, iterables) &&
        eq(value, otherValue, { a: [], b: [] }, iterables)
      ) {
        found = true
      }
    }
    if (!found) return false
  }
  return true
}

/** The own properties an iterable has beside what it iterates over. */
function extraEntries(value: object): unknown[][] {
  const symbols = Object.getOwnPropertySymbols(value)
    .filter((symbol) => symbol !== Symbol.iterator)
    .map((symbol) => [symbol, (value as Keyed)[symbol]])
  return [...symbols, ...Object.entries(value)]
}

/** `iterableEquality`: `undefined` when it has no opinion, so the object comparison decides. */
function iterablesEqual(a: object, b: object, stacks: Stacks): boolean | undefined {
  if (Array.isArray(a) || Array.isArray(b) || ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    return undefined
  }
  if (!isIterable(a) || !isIterable(b)) return undefined
  if (!sameConstructor(a, b)) return false
  for (let index = stacks.a.length - 1; index >= 0; index--) {
    if (stacks.a[index] === a) return stacks.b[index] === b
  }
  const inner: Stacks = { a: [...stacks.a, a], b: [...stacks.b, b] }
  const sizeOfA = (a as { size?: unknown }).size
  if (sizeOfA !== undefined) {
    if (sizeOfA !== (b as { size?: unknown }).size) return false
    if (toStringTag(a) === '[object Set]') {
      return setsEqual(a as Set<unknown>, b as Set<unknown>, inner)
    }
    if (toStringTag(a) === '[object Map]') {
      return mapsEqual(a as Map<unknown, unknown>, b as Map<unknown, unknown>, inner)
    }
  }
  let left: Iterator<unknown>
  let right: Iterator<unknown>
  try {
    left = (a as Iterable<unknown>)[Symbol.iterator]()
    right = (b as Iterable<unknown>)[Symbol.iterator]()
  } catch {
    // An iterator factory that throws can't be compared as an iterable: the properties decide.
    return undefined
  }
  for (let step = left.next(); !step.done; step = left.next()) {
    const other = right.next()
    if (other.done || !eq(step.value, other.value, { a: [], b: [] }, inner)) return false
  }
  if (!right.next().done) return false
  return eq(extraEntries(a), extraEntries(b), { a: [], b: [] }, null)
}

function isDomNode(value: object): value is { isEqualNode(other: unknown): boolean } {
  const node = value as { nodeType?: unknown; nodeName?: unknown; isEqualNode?: unknown }
  return (
    typeof node.nodeType === 'number' &&
    typeof node.nodeName === 'string' &&
    typeof node.isEqualNode === 'function'
  )
}

function objectsEqual(a: object, b: object, stacks: Stacks, iterables: Stacks | null): boolean {
  if (isDomNode(a) && isDomNode(b)) return a.isEqualNode(b)
  for (let index = stacks.a.length - 1; index >= 0; index--) {
    if (stacks.a[index] === a) return stacks.b[index] === b
    if (stacks.b[index] === b) return false
  }
  stacks.a.push(a)
  stacks.b.push(b)
  const left = a as Keyed
  const right = b as Keyed
  const aKeys = ownKeys(a)
  const bKeys = ownKeys(b)
  // A key that holds `undefined` or an asymmetric matcher counts on both sides, present or not.
  const countsWhenMissing = (value: unknown): boolean => value === undefined || isAsymmetric(value)
  for (const key of [...bKeys]) {
    if (countsWhenMissing(right[key]) && !Object.hasOwn(a, key)) aKeys.push(key)
  }
  for (const key of [...aKeys]) {
    if (countsWhenMissing(left[key]) && !Object.hasOwn(b, key)) bKeys.push(key)
  }
  if (aKeys.length !== bKeys.length) return false
  for (let index = aKeys.length - 1; index >= 0; index--) {
    const key = aKeys[index] as PropertyKey
    if (!Object.hasOwn(b, key) && !countsWhenMissing(left[key])) return false
    if (!eq(left[key], right[key], stacks, iterables)) return false
  }
  stacks.a.pop()
  stacks.b.pop()
  return true
}

function eq(a: unknown, b: unknown, stacks: Stacks, iterables: Stacks | null): boolean {
  const asymmetricA = isAsymmetric(a)
  const asymmetricB = isAsymmetric(b)
  if (asymmetricA && !asymmetricB) return a.asymmetricMatch(b)
  if (asymmetricB && !asymmetricA) return b.asymmetricMatch(a)

  if (iterables !== null && typeof a === 'object' && typeof b === 'object' && a && b) {
    const result = iterablesEqual(a, b, iterables)
    if (result !== undefined) return result
  }
  // Only the message, as `equals` has it: an `Error` and a `TypeError` that say the same are equal.
  if (a instanceof Error && b instanceof Error) return a.message === b.message
  if (Object.is(a, b)) return true
  if (a === null || b === null) return false

  const tag = toStringTag(a)
  if (tag !== toStringTag(b)) return false
  switch (tag) {
    case '[object Boolean]':
    case '[object String]':
    case '[object Number]':
      // Two different primitives are settled by `Object.is`; two boxes compare what they box.
      if (typeof a !== 'object' || typeof b !== 'object') return false
      return Object.is((a as object).valueOf(), (b as object).valueOf())
    case '[object Date]':
      return +(a as Date) === +(b as Date)
    case '[object RegExp]':
      return (
        (a as RegExp).source === (b as RegExp).source && (a as RegExp).flags === (b as RegExp).flags
      )
    case '[object URL]':
      return (a as URL).href === (b as URL).href
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return objectsEqual(a as object, b as object, stacks, iterables)
}

/** Whether two call-argument values are equal, as `equals(a, b, [iterableEquality])` says. */
export function argsEqual(a: unknown, b: unknown): boolean {
  return eq(a, b, { a: [], b: [] }, { a: [], b: [] })
}
