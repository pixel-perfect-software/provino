// Patches Node's CommonJS loader in the process that runs the tests (in band, `-i`), as Next.js's
// require hook does when next/jest's config or transformer loads: `Module.prototype.require`
// rewrites a `.shared-runtime` request, `Module._resolveFilename` aliases a package, and
// `Module._load` answers a request no package installs.
type Loader = (this: unknown, request: string, ...rest: unknown[]) => unknown
const Module = require('node:module') as unknown as {
  prototype: { require: Loader }
  _resolveFilename: Loader
  _load: Loader
}

module.exports = function globalSetup(): void {
  const require0 = Module.prototype.require
  Module.prototype.require = function (this: unknown, request: string): unknown {
    return require0.call(this, request.endsWith('.shared-runtime') ? './vendored-context' : request)
  }
  const resolve0 = Module._resolveFilename
  Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): unknown {
    return resolve0.call(this, request === 'styled-like' ? 'styled-bundled' : request, ...rest)
  }
  const load0 = Module._load
  Module._load = function (this: unknown, request: string, ...rest: unknown[]): unknown {
    if (request === 'only-the-hook-loads') return 'what the hook loaded'
    return load0.call(this, request, ...rest)
  }
}
