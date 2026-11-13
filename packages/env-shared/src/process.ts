// A test file's own `process` (`orchestrator.processObject: 'per-file'`), made the way jest-util
// 30.5's `createProcessObject` makes one for every file (rebuilt here, not copied): the worker's
// `process` with its prototype, every own property but `env`, `mainModule` and `_events`, nested
// objects copied, the prototype chain's constructors run on it (EventEmitter's gives it a listener
// table of its own), a copy of `env` behind a proxy that keeps values strings, a `send` that does
// nothing and `domain` read from the worker's. The worker never emits on it, so a listener a file
// adds is never called and goes with the file. jest-runtime also answers
// `getBuiltinModule('process')` with the copy; so does this one.
import { Buffer } from 'node:buffer'
import host from 'node:process'

/** Own keys the copy leaves out: `env` and `_events` are its own, `mainModule` is the worker's entry. */
const LEFT_OUT: ReadonlySet<string | symbol> = new Set(['env', 'mainModule', '_events'])
const PROCESS_IDS: ReadonlySet<string> = new Set(['process', 'node:process'])

type Loose = Record<string | symbol, unknown>

function isCopied(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Buffer.isBuffer(value)
}

/** jest-util's `deepCyclicCopy` with `keepPrototype`: arrays element by element, objects by descriptor, every key configurable. */
function deepCopy(value: unknown, cycles: WeakMap<object, unknown>): unknown {
  if (!isCopied(value)) return value
  if (cycles.has(value)) return cycles.get(value)
  if (Array.isArray(value)) {
    const Constructor = Object.getPrototypeOf(value).constructor as ArrayConstructor
    const copy: unknown[] = new Constructor(value.length)
    cycles.set(value, copy)
    for (let index = 0; index < value.length; index++) {
      copy[index] = deepCopy(value[index], cycles)
    }
    return copy
  }
  const copy: object = Object.create(Object.getPrototypeOf(value))
  cycles.set(value, copy)
  const descriptors: Record<string | symbol, PropertyDescriptor> =
    Object.getOwnPropertyDescriptors(value)
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key] as PropertyDescriptor
    if (descriptor.value !== undefined) descriptor.value = deepCopy(descriptor.value, cycles)
    descriptor.configurable = true
  }
  return Object.defineProperties(copy, descriptors)
}

/**
 * jest-util's `createProcessEnv`: a copy of the worker's `env` behind a proxy that turns every
 * value assigned into a string, and on Windows reads names in any case.
 */
function copyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isWin32 = host.platform === 'win32'
  const values: Loose = Object.create(Object.getPrototypeOf(env))
  const lowered: Loose = {}
  for (const key of Object.keys(env)) {
    const value = env[key]
    values[key] = value
    lowered[key.toLowerCase()] = value
  }
  const prototype: object = Object.getPrototypeOf(env)
  return new Proxy(values, {
    get(_target, key) {
      if (isWin32 && typeof key === 'string')
        return lowered[key in prototype ? key : key.toLowerCase()]
      return values[key]
    },
    set(_target, key, value) {
      const text = `${value}`
      if (typeof key === 'string') lowered[key.toLowerCase()] = text
      values[key] = text
      return true
    },
    deleteProperty(_target, key) {
      for (const name of isWin32 ? Object.keys(values) : [key]) {
        const same =
          typeof key === 'string' && typeof name === 'string' && isWin32
            ? name.toLowerCase() === key.toLowerCase()
            : name === key
        if (!same) continue
        delete values[name]
        delete lowered[typeof name === 'string' && isWin32 ? name.toLowerCase() : name]
      }
      return true
    },
  }) as NodeJS.ProcessEnv
}

/**
 * A copy of the worker's `process` for one test file (see the file's header). Its event listeners
 * and its `env` are its own; the members that act on the process (`exit`, `exitCode`, `stdout`,
 * `cwd`, `kill`, `emitWarning`) are the worker's, so they act as before.
 * @public
 */
export function createFileProcess(): NodeJS.Process {
  const copy: Loose = Object.create(Object.getPrototypeOf(host))
  const cycles = new WeakMap<object, unknown>([[host, copy]])
  const descriptors: Record<string | symbol, PropertyDescriptor> =
    Object.getOwnPropertyDescriptors(host)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key] as PropertyDescriptor
    if (LEFT_OUT.has(key)) {
      delete descriptors[key]
      continue
    }
    descriptor.configurable = true
    const { value } = descriptor
    if (typeof key === 'symbol' || !isCopied(value)) continue
    if (descriptor.writable === true) {
      descriptor.value = deepCopy(value, cycles)
      continue
    }
    // A read-only object (`config`, `versions`, `release`, `features`, `moduleLoadList`) is copied
    // when it is first read: copying `config` and `moduleLoadList` up front costs more than the
    // rest of the copy, and few files read them.
    const { enumerable = false } = descriptor
    descriptors[key] = {
      configurable: true,
      enumerable,
      get() {
        const copied = deepCopy(value, cycles)
        Object.defineProperty(copy, key, {
          value: copied,
          writable: false,
          enumerable,
          configurable: true,
        })
        return copied
      },
    }
  }
  Object.defineProperties(copy, descriptors)
  // As jest-util does: every constructor on the prototype chain runs on the copy, and
  // EventEmitter's gives it a listener table of its own.
  for (
    let proto = Object.getPrototypeOf(host);
    proto !== null;
    proto = Object.getPrototypeOf(proto)
  ) {
    const make = (proto as { readonly constructor?: unknown }).constructor
    if (typeof make === 'function') Reflect.apply(make, copy, [])
  }
  copy.env = copyEnv(host.env)
  copy.send = () => true
  Object.defineProperty(copy, 'domain', {
    configurable: true,
    enumerable: true,
    get: () => (host as unknown as Loose).domain,
  })
  const getBuiltinModule = host.getBuiltinModule
  if (typeof getBuiltinModule === 'function') {
    copy.getBuiltinModule = (id: string): unknown =>
      PROCESS_IDS.has(id) ? copy : Reflect.apply(getBuiltinModule, host, [id])
  }
  return copy as unknown as NodeJS.Process
}
