// `spyOn` and `replaceProperty` (T4.4). `spyInstall` picks one of two flows, and every check a
// dialect's users can see belongs to one of them:
//
// - `assign` follows jest-mock's `spyOn` (index.ts L1269-L1446): its checks and messages, and the
//   spy installed by plain assignment unless the property has a getter.
// - `define` follows @vitest/spy's `spyOn`: fewer checks, the spy installed by `defineProperty`,
//   whose own error is what a non-configurable property reports.
//
// One thing in both is deliberately not upstream's: a restorer is registered only after a
// successful install. jest-mock registers first, so one failed `spyOn` on a frozen object makes
// every later `restoreAllMocks()` throw (Track 4 L227, DECISIONS D7, DIVERGENCES DV7).
import type { MockPolicy } from '@provino/types'
import { MockError, MockTypeError } from './errors.ts'
import { fill, type MockMessageCode, messageFor } from './internal/messages.ts'
import { createMockFn, isMockFunction, MOCK_BRAND } from './mock-fn.ts'
import type { MockRegistry, Restorer } from './registry.ts'
import type {
  FunctionLike,
  Mock,
  Replaced,
  SpiedGetter,
  SpiedMethod,
  SpiedSetter,
  SpyableKeys,
  UnknownFunction,
} from './types.ts'

type AnyObject = Record<PropertyKey, unknown>
type Access = 'get' | 'set'

/** `MOCK_SPY_MISSING` for `spy-missing`: an error's stable code comes from its message's. */
function errorCode(code: MockMessageCode): string {
  return `MOCK_${code.toUpperCase().replaceAll('-', '_')}`
}

function text(policy: MockPolicy, code: MockMessageCode, key: unknown, type: string): string {
  return messageFor(policy, code, { key: String(key), type })
}

function fail(policy: MockPolicy, code: MockMessageCode, key?: unknown, type = ''): never {
  throw new MockError(errorCode(code), text(policy, code, key, type))
}

function failType(policy: MockPolicy, code: MockMessageCode, key: unknown, type: string): never {
  throw new MockTypeError(errorCode(code), text(policy, code, key, type))
}

function typeOf(value: unknown): string {
  return value === null || value === undefined ? `${value}` : typeof value
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}

/**
 * The property's descriptor, from the object or the nearest prototype that has it. A mock's methods
 * are accessors on a frozen prototype only as an implementation detail: to a spy they are the plain
 * inherited methods they stand for, and copying that accessor would install a non-configurable one.
 */
function findDescriptor(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  let current: object | null = object
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor?.get !== undefined && current !== object && Object.hasOwn(current, MOCK_BRAND)) {
      return {
        value: Reflect.get(object, key),
        writable: true,
        enumerable: true,
        configurable: true,
      }
    }
    if (descriptor !== undefined) return descriptor
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

/** An own property gets its descriptor back; one that was inherited is deleted. */
function putBackDescriptor(
  isOwner: boolean,
  subject: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (isOwner && descriptor !== undefined) Object.defineProperty(subject, key, descriptor)
  else Reflect.deleteProperty(subject, key)
}

/** An own property gets its value assigned back; one that was inherited is deleted. */
function putBackValue(isOwner: boolean, target: AnyObject, key: PropertyKey, value: unknown): void {
  if (isOwner) target[key] = value
  else delete target[key]
}

function makeSpy(
  policy: MockPolicy,
  registry: MockRegistry,
  original: FunctionLike | undefined,
  restore: () => void,
): Mock {
  return createMockFn<UnknownFunction>(policy, registry, { spy: true, original, restore })
}

/** Install first, then register, so a failed install leaves nothing to restore (DV7). */
function install(registry: MockRegistry, spy: Mock, restore: Restorer, run: () => void): Mock {
  run()
  registry.addRestorer(restore)
  return spy
}

function spyAssign(
  policy: MockPolicy,
  registry: MockRegistry,
  subject: unknown,
  key: PropertyKey,
  access: Access | undefined,
): unknown {
  if (!isObjectLike(subject)) fail(policy, 'spy-primitive', key, typeOf(subject))
  if (key === null || key === undefined) fail(policy, 'spy-no-key')
  if (access !== undefined) return spyAssignAccessor(policy, registry, subject, key, access)

  const target = subject as AnyObject
  const original = target[key]
  if (!original) fail(policy, 'spy-missing', key)
  if (isMockFunction(policy, original)) return original
  if (typeof original !== 'function') {
    // jest-mock's message has its `replaceProperty` hint only for a non-object.
    const code =
      typeof original === 'object' ? 'spy-not-a-function' : 'spy-not-a-function-primitive'
    failType(policy, code, key, typeOf(original))
  }
  const isOwner = Object.hasOwn(subject, key)
  const descriptor = findDescriptor(subject, key)
  if (descriptor?.get !== undefined) {
    const installed: PropertyDescriptor = { ...descriptor }
    const restore = (): void => putBackDescriptor(isOwner, subject, key, descriptor)
    const spy = makeSpy(policy, registry, original as FunctionLike, restore)
    installed.get = () => spy
    return install(registry, spy, restore, () => Object.defineProperty(subject, key, installed))
  }
  const restore = (): void => putBackValue(isOwner, target, key, original)
  const spy = makeSpy(policy, registry, original as FunctionLike, restore)
  return install(registry, spy, restore, () => {
    try {
      target[key] = spy
    } catch (error) {
      throw readOnlyError(policy, subject, key, error)
    }
  })
}

/**
 * V8's error for assigning to a read-only property names the object, and how it does depends on the
 * realm the assignment runs in. A policy recorded from another realm gives the text as
 * `spy-read-only`, with `{tag}` as `Object.prototype.toString` has it. Without one, or for any other
 * error, the original goes through.
 */
function readOnlyError(
  policy: MockPolicy,
  subject: object,
  key: PropertyKey,
  error: unknown,
): unknown {
  const message = policy.messages['spy-read-only']
  if (message === undefined) return error
  if (!(error instanceof TypeError)) return error
  if (!error.message.startsWith('Cannot assign to read only property')) return error
  const tag = Object.prototype.toString.call(subject)
  return new MockTypeError('MOCK_SPY_READ_ONLY', fill(message, { key: String(key), tag }), {
    cause: error,
  })
}

function spyAssignAccessor(
  policy: MockPolicy,
  registry: MockRegistry,
  subject: object,
  key: PropertyKey,
  access: Access,
): unknown {
  const isOwner = Object.hasOwn(subject, key)
  const descriptor = findDescriptor(subject, key)
  if (descriptor === undefined) fail(policy, 'spy-missing', key)
  if (!descriptor.configurable) fail(policy, 'spy-not-configurable', key)
  const original = descriptor[access]
  if (original === undefined) fail(policy, 'spy-no-access-type', key, access)
  if (isMockFunction(policy, original)) return original
  const restore = (): void => putBackDescriptor(isOwner, subject, key, descriptor)
  const spy = makeSpy(policy, registry, original as FunctionLike, restore)
  return install(registry, spy, restore, () =>
    Object.defineProperty(subject, key, { ...descriptor, [access]: spy }),
  )
}

function spyDefine(
  policy: MockPolicy,
  registry: MockRegistry,
  subject: unknown,
  key: PropertyKey,
  access: Access | undefined,
): unknown {
  if (subject === null || subject === undefined) fail(policy, 'spy-nullish')
  if (!isObjectLike(subject)) fail(policy, 'spy-define-primitive')
  const isOwner = Object.hasOwn(subject, key)
  const descriptor = findDescriptor(subject, key)
  if (descriptor === undefined && !(key in subject)) {
    fail(policy, 'spy-define-missing', key, typeof subject)
  }
  const target = subject as AnyObject

  let slot: 'value' | Access = access ?? 'value'
  // The Vite SSR rule: an export is a getter holding the function.
  let ssr = false
  if (slot === 'value' && descriptor?.value == null && descriptor?.get !== undefined) {
    slot = 'get'
    ssr = true
  }
  let original: unknown
  if (descriptor !== undefined) {
    original = descriptor[slot]
    if (original == null && slot === 'value') original = target[key]
  } else if (slot !== 'value') {
    original = () => target[key]
  } else {
    original = target[key]
  }
  const implementation: unknown =
    ssr && typeof original === 'function' ? (original as () => unknown)() : original
  if (typeof implementation !== 'function' && (slot === 'value' || original != null)) {
    fail(policy, 'spy-define-not-a-function', key, typeof implementation)
  }
  if (isMockFunction(policy, implementation)) return implementation

  const define = (value: unknown): void => {
    const { value: _replaced, ...rest } = descriptor ?? { configurable: true, writable: true }
    if (slot !== 'value') delete rest.writable
    Object.defineProperty(subject, key, { ...rest, [slot]: value })
  }
  const restore = (): void => {
    if (!isOwner || (descriptor !== undefined && !original)) {
      putBackDescriptor(isOwner, subject, key, descriptor)
    } else define(original)
  }
  const spy = makeSpy(policy, registry, implementation as FunctionLike | undefined, restore)
  return install(registry, spy, restore, () => {
    try {
      define(ssr ? () => spy : spy)
    } catch (error) {
      if (error instanceof TypeError && isNamespaceRefusal(subject, error)) {
        throw new MockTypeError(
          errorCode('spy-namespace'),
          text(policy, 'spy-namespace', key, ''),
          {
            cause: error,
          },
        )
      }
      throw error
    }
  })
}

function isNamespaceRefusal(subject: object, error: TypeError): boolean {
  return (
    (subject as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === 'Module' &&
    (error.message.includes('Cannot redefine property') ||
      error.message.includes('Cannot replace module namespace'))
  )
}

/**
 * Replaces a function or class property with a spy that calls through. A property already holding
 * a mock returns that mock.
 * @public
 */
export function spyOn<T extends object, K extends SpyableKeys<T>>(
  policy: MockPolicy,
  registry: MockRegistry,
  object: T,
  key: K,
): SpiedMethod<Required<T>[K]>
/**
 * Replaces an accessor's getter with a spy that calls through.
 * @public
 */
export function spyOn<T extends object, K extends keyof T>(
  policy: MockPolicy,
  registry: MockRegistry,
  object: T,
  key: K,
  access: 'get',
): SpiedGetter<T[K]>
/**
 * Replaces an accessor's setter with a spy that calls through.
 * @public
 */
export function spyOn<T extends object, K extends keyof T>(
  policy: MockPolicy,
  registry: MockRegistry,
  object: T,
  key: K,
  access: 'set',
): SpiedSetter<T[K]>
export function spyOn(
  policy: MockPolicy,
  registry: MockRegistry,
  object: object,
  key: PropertyKey,
  access?: Access,
): unknown {
  return policy.spyInstall === 'assign'
    ? spyAssign(policy, registry, object, key, access)
    : spyDefine(policy, registry, object, key, access)
}

/**
 * Replaces a plain value property until `restore` or the registry's `restoreAll`. Follows
 * jest-mock's `replaceProperty` (index.ts L1448-L1558), but, like `spyOn`, registers its restorer
 * only after the first write has worked.
 * @public
 */
export function replaceProperty<T extends object, K extends keyof T>(
  policy: MockPolicy,
  registry: MockRegistry,
  object: T,
  key: K,
  value: T[K],
): Replaced<T[K]> {
  if (!isObjectLike(object)) fail(policy, 'replace-primitive', key, typeOf(object))
  if (key === null || key === undefined) fail(policy, 'replace-no-key')
  const descriptor = findDescriptor(object, key)
  if (descriptor === undefined) fail(policy, 'replace-missing', key)
  if (!descriptor.configurable) fail(policy, 'replace-not-configurable', key)
  if (descriptor.get !== undefined) fail(policy, 'replace-getter', key)
  if (descriptor.set !== undefined) fail(policy, 'replace-setter', key)
  if (typeof descriptor.value === 'function') failType(policy, 'replace-function', key, '')

  const existing = registry.findRestorer(object, key)
  if (existing !== undefined) return (existing.replaced as Replaced<T[K]>).replaceValue(value)

  const isOwner = Object.hasOwn(object, key)
  const originalValue = descriptor.value as T[K]
  const restorer: Restorer = () =>
    putBackValue(isOwner, object as AnyObject, key as PropertyKey, originalValue)
  const replaced: Replaced<T[K]> = {
    replaceValue(next: T[K]): Replaced<T[K]> {
      object[key] = next
      return replaced
    },
    restore(): void {
      restorer()
      registry.deleteRestorer(restorer)
    },
  }
  restorer.object = object
  restorer.property = key
  restorer.replaced = replaced
  replaced.replaceValue(value)
  registry.addRestorer(restorer)
  return replaced
}
