// Preloaded (`--import`) into every child that runs a sample config (D28: "network off"). It
// replaces every way JavaScript reaches the network with a throw: sockets, TLS, HTTP(S), HTTP/2,
// UDP, `fetch`, and DNS (every `lookup*`, `resolve*` and `reverse` function, on `node:dns` and its
// promises API, and on both `Resolver` classes). The module objects are patched, then
// `syncBuiltinESMExports()` updates the named ESM exports, so `import { lookup } from 'node:dns'`
// gets the patched function too. The child also runs under Node's permission model
// (`--permission`): no child processes, no workers, and writes only to its result file, so a
// config can't reach out that way.
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import tls from 'node:tls'

function refuse(name: string): never {
  throw new Error(`network is off while reading a sample config (${name})`)
}

function block(target: object, name: string, label = name): void {
  Object.defineProperty(target, name, {
    value: (..._args: unknown[]): never => refuse(label),
    configurable: true,
    writable: true,
  })
}

/** DNS's network functions on a module or a resolver: lookups, resolutions, reverse lookups. */
function dnsFunctionNames(target: object): string[] {
  const names = new Set<string>()
  for (
    let at: object | null = target;
    at !== null && at !== Object.prototype;
    at = Object.getPrototypeOf(at)
  ) {
    for (const name of Object.getOwnPropertyNames(at)) {
      if (/^(lookup|resolve|reverse)/.test(name) && typeof Reflect.get(at, name) === 'function') {
        names.add(name)
      }
    }
  }
  return [...names]
}

block(net.Socket.prototype, 'connect', 'net.Socket.connect')
for (const [module, names, label] of [
  [net, ['connect', 'createConnection'], 'net'],
  [tls, ['connect'], 'tls'],
  [http, ['request', 'get'], 'http'],
  [https, ['request', 'get'], 'https'],
  [http2, ['connect'], 'http2'],
  [dgram, ['createSocket'], 'dgram'],
] as const) {
  for (const name of names) block(module, name, `${label}.${name}`)
}
for (const [module, label] of [
  [dns, 'dns'],
  [dns.promises, 'dns.promises'],
] as const) {
  for (const name of dnsFunctionNames(module)) block(module, name, `${label}.${name}`)
}
for (const [resolver, label] of [
  [dns.Resolver.prototype, 'dns.Resolver'],
  [dns.promises.Resolver.prototype, 'dns.promises.Resolver'],
] as const) {
  for (const name of dnsFunctionNames(resolver)) block(resolver, name, `${label}#${name}`)
}
Object.defineProperty(globalThis, 'fetch', {
  value: async () => refuse('fetch'),
  configurable: true,
  writable: true,
})
for (const name of ['WebSocket', 'EventSource']) {
  if (name in globalThis) {
    Object.defineProperty(globalThis, name, {
      value: class {
        constructor() {
          refuse(name)
        }
      },
      configurable: true,
      writable: true,
    })
  }
}
// The named ESM exports of the built-ins are copies taken at startup; this refreshes them.
syncBuiltinESMExports()
