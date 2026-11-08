// Automock (T4.6): a module's real exports in, a mocked copy out. Two shapes, picked by
// `ModulePolicy.automockShape`, both over `createMockFn` through the caller's `mk`:
//
// - `metadata` is jest-mock's `getMetadata` + `generateFromMetadata` (index.ts L471-L598,
//   L707-L760, L1077-L1220) folded into one walk. A value of a kind `getType` can't name (`Date`,
//   `BigInt`, a `Promise`) is left out, a `RegExp` is emptied, and the module gets `__esModule`.
// - `deep` is `@vitest/mocker`'s `mockObject` (automocker.ts), cycle handling included.
//
// Instances of a mocked class get their own method mocks, which fall through to the prototype's
// mock, so a call records on both (`protoMethodCalls: 1`). The constructor body never runs.
import type { ModulePolicy } from '@provino/types'
import { MockError } from '../errors.ts'
import type { CreateMockOptions, UnknownFunction } from '../types.ts'

/**
 * `automock` mocks everything; `autospy` keeps the real behaviour and records calls (Vitest's
 * `vi.mock(path, { spy: true })`).
 * @public
 */
export type AutomockMode = 'automock' | 'autospy'

/**
 * Makes one mock function, as `createMockFn` does with the file's policy and registry bound.
 * @public
 */
export type AutomockMaker = (options: CreateMockOptions) => UnknownFunction

type Bag = Record<PropertyKey, unknown>

const OBJECT_PROTOTYPE: object = Object.prototype
const FUNCTION_PROTOTYPE: object = Function.prototype
const REGEXP_PROTOTYPE: object = RegExp.prototype

const FUNCTION_NAME_RESERVED_PATTERN = /[\s!-/:-@[-`{-~]/
const FUNCTION_NAME_RESERVED_REPLACE = /[\s!-/:-@[-`{-~]/g

// jest-mock index.ts L301-L350.
const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1)
}

function isFunctionTag(tag: string): boolean {
  return (
    tag === 'Function' ||
    tag === 'AsyncFunction' ||
    tag === 'GeneratorFunction' ||
    tag === 'AsyncGeneratorFunction'
  )
}

/** jest-mock's and @vitest/mocker's `isReadonlyProp`: the same table. */
function isReadonlyProp(object: unknown, prop: PropertyKey): boolean {
  if (typeof prop === 'symbol') return false
  if (
    prop === 'arguments' ||
    prop === 'caller' ||
    prop === 'callee' ||
    prop === 'name' ||
    prop === 'length'
  ) {
    return isFunctionTag(tagOf(object))
  }
  if (prop === 'source' || prop === 'global' || prop === 'ignoreCase' || prop === 'multiline') {
    return tagOf(object) === 'RegExp'
  }
  return false
}

interface Slot {
  readonly key: string | symbol
  readonly descriptor: PropertyDescriptor
}

/**
 * Every own property of `object` and of its prototypes, up to (not including) `Object.prototype`,
 * `Function.prototype` and `RegExp.prototype`. The nearest descriptor wins.
 */
function collectSlots(object: object, symbols: boolean): Slot[] {
  const seen = new Map<string | symbol, Slot>()
  let current: object | null = object
  while (
    current !== null &&
    current !== OBJECT_PROTOTYPE &&
    current !== FUNCTION_PROTOTYPE &&
    current !== REGEXP_PROTOTYPE
  ) {
    const keys: Array<string | symbol> = Object.getOwnPropertyNames(current)
    if (symbols) keys.push(...Object.getOwnPropertySymbols(current))
    for (const key of keys) {
      if (seen.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined) seen.set(key, { key, descriptor })
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return [...seen.values()]
}

function assign(container: object, key: PropertyKey, value: unknown): boolean {
  try {
    ;(container as Bag)[key] = value
    return true
  } catch {
    return false
  }
}

function read(container: object, key: PropertyKey): { readonly value: unknown } | null {
  try {
    return { value: (container as Bag)[key] }
  } catch {
    return null
  }
}

/**
 * The name a Jest automock gives a function, as `_createMockFunction` writes it (index.ts
 * L1011-L1063): a `bound ` prefix survives once, `mockConstructor` and the empty name leave the
 * mock its default, and a name that wouldn't be an identifier is rewritten.
 */
function metadataName(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  let name = raw
  let bound = false
  while (name.startsWith('bound ')) {
    name = name.slice('bound '.length)
    bound = true
  }
  if (name === 'mockConstructor' || name === '') return undefined
  if (RESERVED_KEYWORDS.has(name) || /^\d/.test(name)) name = `$${name}`
  if (FUNCTION_NAME_RESERVED_PATTERN.test(name)) {
    name = name.replaceAll(FUNCTION_NAME_RESERVED_REPLACE, '$')
  }
  return bound ? `bound ${name}` : name
}

/**
 * What a mocked class does when constructed: give the instance its own mock for each method on the
 * prototype, falling through to the prototype's own mock. A plain call does nothing.
 */
function instanceMethods(
  mk: AutomockMaker,
  members: readonly (string | symbol)[],
  nameOf: (key: string | symbol) => string | undefined,
  owner: { mock: UnknownFunction | null },
): UnknownFunction {
  return function constructInstance(this: unknown): undefined {
    // A construction is a call whose `this` is an instance of the mock: under `newCall: 'apply'`
    // (jest-mock's `mockConstructor`, `this instanceof f`) there is no `new.target` to look at.
    if (this === null || typeof this !== 'object') return undefined
    if (owner.mock === null || !(this instanceof owner.mock)) return undefined
    const instance = this as Bag
    for (const key of members) {
      const protoMethod = instance[key]
      if (typeof protoMethod !== 'function') continue
      const name = nameOf(key)
      instance[key] = mk(
        name === undefined
          ? { fallback: protoMethod as UnknownFunction }
          : { name, fallback: protoMethod as UnknownFunction },
      )
    }
    return undefined
  }
}

function functionKeys(prototype: object, symbols: boolean): Array<string | symbol> {
  const keys: Array<string | symbol> = []
  for (const { key, descriptor } of collectSlots(prototype, symbols)) {
    if (key === 'constructor' || descriptor.get !== undefined) continue
    if (typeof descriptor.value === 'function') keys.push(key)
  }
  return keys
}

// ---- the `metadata` shape: jest-mock ----

type MetadataType =
  | 'function'
  | 'array'
  | 'object'
  | 'constant'
  | 'collection'
  | 'regexp'
  | 'null'
  | 'undefined'

/** jest-mock's `getType` (index.ts L471-L506). `null` means "no metadata": the value is left out. */
function metadataType(ref: unknown): MetadataType | null {
  const tag = tagOf(ref)
  if (isFunctionTag(tag)) return 'function'
  if (Array.isArray(ref)) return 'array'
  if (tag === 'Object' || tag === 'Module') return 'object'
  if (tag === 'Number' || tag === 'String' || tag === 'Boolean' || tag === 'Symbol')
    return 'constant'
  if (tag === 'Map' || tag === 'WeakMap' || tag === 'Set') return 'collection'
  if (tag === 'RegExp') return 'regexp'
  if (ref === undefined) return 'undefined'
  if (ref === null) return 'null'
  return null
}

/** jest-mock's `_getSlots` (index.ts L557-L599): a getter is not a slot, unless the object is an ES module. */
function metadataSlots(object: object): string[] {
  const esModule = (object as Bag).__esModule
  const slots: string[] = []
  for (const { key, descriptor } of collectSlots(object, false)) {
    if (typeof key !== 'string' || isReadonlyProp(object, key)) continue
    if (descriptor.get === undefined || esModule) slots.push(key)
  }
  return slots
}

function isMockLike(value: unknown): boolean {
  return typeof value === 'function' && (value as unknown as Bag)._isMockFunction === true
}

function fromMetadata(root: unknown, mode: AutomockMode, mk: AutomockMaker): unknown {
  const made = new Map<unknown, unknown>()
  const backReferences: Array<() => void> = []

  const build = (value: unknown): { readonly mock: unknown } | null => {
    const type = metadataType(value)
    if (type === null) return null
    if (type === 'constant' || type === 'collection' || type === 'null' || type === 'undefined') {
      return { mock: value }
    }

    let mock: unknown
    // Filled once the prototype is built, before any instance is made.
    const protoSlots: Array<string | symbol> = []
    const owner: { mock: UnknownFunction | null } = { mock: null }
    if (type === 'object') mock = {}
    else if (type === 'array') mock = []
    else if (type === 'regexp') mock = /(?:)/
    else {
      const original = value as UnknownFunction
      const name = metadataName(original.name)
      const base: CreateMockOptions = name === undefined ? {} : { name }
      mock =
        mode === 'autospy'
          ? mk({ ...base, original })
          : mk({
              ...base,
              fallback: instanceMethods(
                mk,
                protoSlots,
                (key) => (typeof key === 'string' ? metadataName(key) : undefined),
                owner,
              ),
            })
      owner.mock = mock as UnknownFunction
    }
    made.set(value, mock)

    if (type !== 'array') {
      const source = value as object
      for (const slot of metadataSlots(source)) {
        if (type === 'function' && isMockLike(source) && slot.startsWith('mock')) continue
        const got = read(source, slot)
        if (got === null) continue
        // A value seen before is a back-reference in jest-mock: set after the whole walk, in the
        // order met, so it lands after the direct members in the key order (`generateFromMetadata`'s
        // `callbacks`).
        const seen = made.get(got.value)
        if (seen !== undefined) {
          backReferences.push(() => {
            assign(mock as object, slot, seen)
          })
          continue
        }
        const child = build(got.value)
        if (child !== null) assign(mock as object, slot, child.mock)
      }
    }

    if (type === 'function') {
      const proto = (mock as Bag).prototype
      if (proto !== null && typeof proto === 'object') {
        // The slots are fixed once the prototype is built; `constructor` is the mock itself below.
        protoSlots.push(...functionKeys(proto, false))
        assign(proto, 'constructor', mock)
      }
    }
    return { mock }
  }

  const result = build(root)
  for (const link of backReferences) link()
  if (result === null) throw new MockError('automock-no-metadata', 'Failed to get mock metadata')
  const mock = result.mock
  // An ES module namespace has no `__esModule`; a transpiled one does, and is mocked with it.
  if (
    tagOf(root) === 'Module' &&
    mock !== null &&
    typeof mock === 'object' &&
    !Object.hasOwn(mock, '__esModule')
  ) {
    Object.defineProperty(mock, '__esModule', { value: true, enumerable: false })
  }
  return mock
}

// ---- the `deep` shape: @vitest/mocker ----

function fromDeep(root: unknown, mode: AutomockMode, mk: AutomockMaker): unknown {
  const finalizers: Array<() => void> = []
  const refs = new Map<unknown, unknown>()

  const createMock = (current: UnknownFunction): UnknownFunction => {
    const name = current.name
    const proto: unknown = current.prototype
    const options: CreateMockOptions = name === '' ? {} : { name }
    if (mode === 'autospy') return mk({ ...options, original: current })
    const members = proto !== null && typeof proto === 'object' ? functionKeys(proto, true) : []
    if (members.length === 0) return mk(options)
    const owner: { mock: UnknownFunction | null } = { mock: null }
    const made = mk({
      ...options,
      fallback: instanceMethods(
        mk,
        members,
        (key) => (typeof key === 'string' ? key : undefined),
        owner,
      ),
    })
    owner.mock = made
    return made
  }

  const mockPropertiesOf = (container: object, target: object): void => {
    const isModule = tagOf(container) === 'Module' || Boolean((container as Bag).__esModule)
    for (const { key, descriptor } of collectSlots(container, true)) {
      // Modules define their exports as getters. Those are read, not replaced.
      if (!isModule && descriptor.get !== undefined) {
        try {
          if (mode === 'autospy') Object.defineProperty(target, key, descriptor)
          else {
            const accessor: PropertyDescriptor = {
              configurable: descriptor.configurable === true,
              enumerable: descriptor.enumerable === true,
              get: () => undefined,
            }
            if (descriptor.set !== undefined) accessor.set = () => undefined
            Object.defineProperty(target, key, accessor)
          }
        } catch {
          // Move on to the next property.
        }
        continue
      }

      const got = read(container, key)
      if (got === null) continue
      if (isReadonlyProp(container, key)) continue
      const value = got.value

      if (refs.has(value)) {
        const mocked = refs.get(value)
        finalizers.push(() => {
          assign(target, key, mocked)
        })
        continue
      }

      const tag = tagOf(value)
      if (Array.isArray(value)) {
        if (mode === 'automock') assign(target, key, [])
        else {
          // The array and each object item are registered before recursing, so a cycle back
          // through them resolves to the copy (upstream overflows the stack; DIVERGENCES).
          const copies: unknown[] = []
          refs.set(value, copies)
          for (const item of value as unknown[]) {
            const known = refs.get(item)
            if (known !== undefined) copies.push(known)
            else if (item !== null && typeof item === 'object') {
              const copy = {}
              refs.set(item, copy)
              copies.push(copy)
              mockPropertiesOf(item, copy)
            } else if (typeof item === 'function') copies.push(createMock(item as UnknownFunction))
            else copies.push(item)
          }
          assign(target, key, copies)
        }
        continue
      }

      const isFunction = tag.includes('Function') && typeof value === 'function'
      if ((!isFunction || isMockLike(value)) && tag !== 'Object' && tag !== 'Module') {
        assign(target, key, value)
        continue
      }

      if (mode === 'autospy' && tag === 'Module') {
        // A clean object, so exported namespaces are autospied recursively.
        const namespace = Object.create(null) as Bag
        Object.defineProperty(namespace, Symbol.toStringTag, {
          value: 'Module',
          configurable: true,
          writable: true,
        })
        if (!assign(target, key, namespace)) continue
      } else if (!assign(target, key, isFunction || mode === 'autospy' ? value : {})) {
        continue
      }

      let child = (target as Bag)[key]
      if (isFunction) {
        child = createMock(child as UnknownFunction)
        ;(target as Bag)[key] = child
      }
      refs.set(value, child)
      mockPropertiesOf(value as object, child as object)
    }
  }

  if (root === null || (typeof root !== 'object' && typeof root !== 'function')) return root
  if (Array.isArray(root)) return mode === 'automock' ? [] : root
  if (isMockLike(root)) return root
  const mocked: object = typeof root === 'function' ? createMock(root as UnknownFunction) : {}
  refs.set(root, mocked)
  mockPropertiesOf(root, mocked)
  for (const finalize of finalizers) finalize()
  return mocked
}

/**
 * Builds the automock of a module's real exports (T4.6). Functions become mocks that return
 * `undefined`; a class's constructor body never runs, and each instance's methods record into the
 * prototype's mocks too. Statics, nested objects and getters are mocked (a getter reads
 * `undefined`); arrays become `[]`; `Map`s, primitives and `null` are kept. Cycles are followed.
 * `metadata` is jest-mock's shape (a `Date` or `BigInt` is dropped, a `RegExp` emptied, the module
 * gets `__esModule`); `deep` is `@vitest/mocker`'s. `autospy` keeps the real behaviour.
 *
 * Throws `MockError` with code `automock-no-metadata` under `metadata` when the root has no
 * metadata, as `getMetadata` returning `null` does.
 * @public
 */
export function automock(
  value: unknown,
  shape: ModulePolicy['automockShape'],
  mode: AutomockMode,
  mk: AutomockMaker,
): unknown {
  return shape === 'metadata' ? fromMetadata(value, mode, mk) : fromDeep(value, mode, mk)
}
