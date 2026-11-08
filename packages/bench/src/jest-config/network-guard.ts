// Preloaded (`--import`) into every child that runs a sample config (D28: "network off"). It
// replaces every way JavaScript reaches the network with a throw: sockets, TLS, DNS, HTTP(S),
// `fetch`, UDP. The child also runs under Node's permission model (`--permission`): no child
// processes, no workers, and writes only to its result file, so a config can't reach out that way.
import dgram from 'node:dgram'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

function refuse(name: string): never {
  throw new Error(`network is off while reading a sample config (${name})`)
}

const blocked =
  (name: string) =>
  (..._args: unknown[]): never =>
    refuse(name)

Object.defineProperty(net.Socket.prototype, 'connect', { value: blocked('net.Socket.connect') })
for (const [module, names] of [
  [net, ['connect', 'createConnection']],
  [tls, ['connect']],
  [http, ['request', 'get']],
  [https, ['request', 'get']],
  [dgram, ['createSocket']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'lookupService']],
  [dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'lookupService']],
] as const) {
  for (const name of names) {
    Object.defineProperty(module, name, {
      value: blocked(name),
      configurable: true,
      writable: true,
    })
  }
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
