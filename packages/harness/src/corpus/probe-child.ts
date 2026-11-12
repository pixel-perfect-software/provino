// The sandbox probe's child (T12.10; `sandbox.ts`). It runs once inside the Seatbelt profile and
// once outside it as a control, makes seven attempts and prints one JSON line for each:
//
//   tcp       a TCP connect to 1.1.1.1:443
//   dns       a lookup of registry.npmjs.org, by the system resolver and by DNS queries
//   https     an HTTPS fetch of registry.npmjs.org (no proxy variables are in this environment)
//   socket    a connect to a unix socket outside the run's directories (the parent listens on it)
//   canary    a read of the canary file the profile denies
//   ssh       a read of a file under ~/.ssh
//   loopback  a connection to a server on 127.0.0.1 (the one that must work)
//
// Only Node builtins: it must load with nothing installed.

import { lookup, Resolver } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import net from 'node:net'

interface Attempt {
  readonly name: string
  readonly outcome: 'ok' | 'error' | 'timeout'
  readonly code?: string
}

const TIMEOUT_MS = 6_000

function codeOf(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const code = Reflect.get(current, 'code')
    if (typeof code === 'string') return code
    current = Reflect.get(current, 'cause')
  }
  return error instanceof Error ? error.name : 'UNKNOWN'
}

function report(attempt: Attempt): void {
  process.stdout.write(`${JSON.stringify(attempt)}\n`)
}

async function attempt(name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
    report({ name, outcome: 'ok' })
  } catch (error) {
    const code = codeOf(error)
    report({ name, outcome: code === 'ETIMEDOUT_PROBE' ? 'timeout' : 'error', code })
  }
}

function connectPath(socketPath: string | undefined): Promise<void> {
  if (socketPath === undefined) {
    return Promise.reject(Object.assign(new Error('no path given'), { code: 'EUSAGE' }))
  }
  return connect({ path: socketPath })
}

function connect(target: net.NetConnectOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT_PROBE' }))
    }, TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    })
  })
}

async function dnsAttempt(): Promise<void> {
  const host = 'registry.npmjs.org'
  const systemResolver = lookup(host)
  const queryResolver = new Resolver({ timeout: 3_000, tries: 1 }).resolve4(host)
  const results = await Promise.allSettled([systemResolver, queryResolver])
  const worked = results.find((result) => result.status === 'fulfilled')
  if (worked !== undefined) return
  const failed = results[0]
  throw failed?.status === 'rejected' ? failed.reason : new Error('no result')
}

async function httpsAttempt(): Promise<void> {
  const response = await fetch('https://registry.npmjs.org/', {
    method: 'HEAD',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  await response.body?.cancel()
}

function readAttempt(file: string | undefined): () => Promise<void> {
  return async () => {
    if (file === undefined) throw Object.assign(new Error('no path given'), { code: 'EUSAGE' })
    readFileSync(file)
  }
}

async function loopbackAttempt(): Promise<void> {
  const server = net.createServer((socket) => socket.end('x'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    await connect({ host: '127.0.0.1', port: address.port })
  } finally {
    server.close()
  }
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index < 0 ? undefined : process.argv[index + 1]
}

await attempt('tcp', () => connect({ host: '1.1.1.1', port: 443 }))
await attempt('dns', dnsAttempt)
await attempt('https', httpsAttempt)
await attempt('socket', () => connectPath(argument('--socket')))
await attempt('canary', readAttempt(argument('--canary')))
await attempt('ssh', readAttempt(argument('--ssh')))
await attempt('loopback', loopbackAttempt)
