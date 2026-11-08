// D28's "network off" for the sample's children: with `network-guard.ts` preloaded, every way a
// config can reach the network is refused, through the module objects and through named ESM
// imports (`import { request } from 'node:http'`), DNS's resolvers and promises included. A child
// runs the attempts; each must be refused at once (a throw, or a promise already rejected), and
// anything else counts as having gone out.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const GUARD = pathToFileURL(fileURLToPath(new URL('network-guard.ts', import.meta.url))).href
const dir = mkdtempSync(join(tmpdir(), 'provino-network-guard-'))
after(() => rmSync(dir, { recursive: true, force: true }))

// Generated at test time as data (D13): the attempts, by named import and through the defaults.
const PROBE = `import { request as httpRequest, get as httpGet } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as http2Connect } from 'node:http2'
import { connect as netConnect, createConnection, Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createSocket } from 'node:dgram'
import dns, { lookup, lookupService, resolve, resolve4, resolveMx, resolveTxt, resolveSrv, resolveCname, reverse, Resolver, promises } from 'node:dns'
import dnsPromises, { Resolver as PromisesResolver, resolveNs } from 'node:dns/promises'

const attempts = {
  'http.request (named)': () => httpRequest('http://127.0.0.1:9/'),
  'http.get (named)': () => httpGet('http://127.0.0.1:9/'),
  'https.request (named)': () => httpsRequest('https://127.0.0.1:9/'),
  'http2.connect (named)': () => http2Connect('http://127.0.0.1:9'),
  'net.connect (named)': () => netConnect(9, '127.0.0.1'),
  'net.createConnection (named)': () => createConnection(9, '127.0.0.1'),
  'new net.Socket().connect': () => new Socket().connect(9, '127.0.0.1'),
  'tls.connect (named)': () => tlsConnect(9, '127.0.0.1'),
  'dgram.createSocket (named)': () => createSocket('udp4'),
  'dns.lookup (named)': () => lookup('localhost', () => {}),
  'dns.lookupService (named)': () => lookupService('127.0.0.1', 22, () => {}),
  'dns.resolve (named)': () => resolve('localhost', () => {}),
  'dns.resolve4 (named)': () => resolve4('localhost', () => {}),
  'dns.resolveMx (named)': () => resolveMx('localhost', () => {}),
  'dns.resolveTxt (named)': () => resolveTxt('localhost', () => {}),
  'dns.resolveSrv (named)': () => resolveSrv('localhost', () => {}),
  'dns.resolveCname (named)': () => resolveCname('localhost', () => {}),
  'dns.reverse (named)': () => reverse('127.0.0.1', () => {}),
  'dns.resolveNaptr (default)': () => dns.resolveNaptr('localhost', () => {}),
  'new dns.Resolver().resolve4': () => new Resolver().resolve4('localhost', () => {}),
  'new dns.Resolver().resolveSoa': () => new Resolver().resolveSoa('localhost', () => {}),
  'dns.promises.lookup': () => promises.lookup('localhost'),
  'dns.promises.resolveMx': () => promises.resolveMx('localhost'),
  'dns/promises resolveNs (named)': () => resolveNs('localhost'),
  'dns/promises default resolveTxt': () => dnsPromises.resolveTxt('localhost'),
  'new dns/promises Resolver().resolve4': () => new PromisesResolver().resolve4('localhost'),
  fetch: () => fetch('http://127.0.0.1:9/'),
}

const refused = (error) => String(error?.message ?? error).includes('network is off')
const results = {}
for (const [name, attempt] of Object.entries(attempts)) {
  let outcome
  try {
    const value = attempt()
    if (value && typeof value.then === 'function') {
      // A guard refusal is a promise that is already rejected; one macrotask settles it.
      outcome = await Promise.race([
        value.then(() => 'went out', (error) => (refused(error) ? 'refused' : 'went out')),
        new Promise((settle) => setImmediate(() => settle('went out'))),
      ])
    } else {
      outcome = 'went out'
      value?.destroy?.()
      value?.close?.()
    }
  } catch (error) {
    outcome = refused(error) ? 'refused' : 'went out'
  }
  results[name] = outcome
}
process.stdout.write(JSON.stringify(results))
process.exit(0)
`

test('the guard refuses every network API, by named import too', () => {
  const probe = join(dir, 'probe.mjs')
  writeFileSync(probe, PROBE)
  const output = execFileSync(process.execPath, ['--import', GUARD, probe], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const results = JSON.parse(output) as Record<string, string>
  const wentOut = Object.entries(results)
    .filter(([, outcome]) => outcome !== 'refused')
    .map(([name]) => name)
  assert.deepEqual(wentOut, [])
  assert.equal(Object.keys(results).length, 27)
})
