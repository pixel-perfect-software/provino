// `withNodeLoader` (`module.nativeLoadPatches: 'skip'`): a native load runs with Node's CommonJS
// loader as Provino found it, whatever the process patched since, and the patches are back after
// it. Against Jest 30.5.2: `cli/module-patch-outer-realm` (`provino`'s `jest-module-patch.test.ts`).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import Module, { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'provino'
import { withNodeLoader } from './node-loader.ts'
import { writeTree } from './test-support.ts'

type Loader = (this: unknown, request: string, ...rest: unknown[]) => unknown
const internals = Module as unknown as {
  prototype: { require: Loader }
  _load: Loader
  _resolveFilename: Loader
}
const original = {
  require: internals.prototype.require,
  load: internals._load,
  resolveFilename: internals._resolveFilename,
}

afterEach(() => {
  internals.prototype.require = original.require
  internals._load = original.load
  internals._resolveFilename = original.resolveFilename
})

/** A package whose own `require`s each meet one of the patches `patchLoader` makes. */
function packageTree(): string {
  return writeTree({
    'node_modules/pkg/package.json': '{ "name": "pkg", "main": "index.js" }\n',
    'node_modules/pkg/index.js': [
      "exports.context = require('./context.shared-runtime')",
      "exports.aliased = require('aliased')",
      "exports.unknown = (() => { try { return require('nowhere') } catch (error) { return error.code } })()",
      '',
    ].join('\n'),
    'node_modules/pkg/context.shared-runtime.js': "module.exports = 'plain'\n",
    'node_modules/pkg/vendored.js': "module.exports = 'redirected'\n",
    'node_modules/aliased/index.js': "module.exports = 'installed'\n",
    'node_modules/alias-target/index.js': "module.exports = 'aliased'\n",
  })
}

/** The three patches Next.js's require hook and its kind make. */
function patchLoader(): void {
  const require0 = internals.prototype.require
  internals.prototype.require = function (this: unknown, request: string): unknown {
    return require0.call(this, request.endsWith('.shared-runtime') ? './vendored' : request)
  }
  const resolve0 = internals._resolveFilename
  internals._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    return resolve0.call(this, request === 'aliased' ? 'alias-target' : request, ...rest)
  }
  const load0 = internals._load
  internals._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'nowhere' ? 'hooked' : load0.call(this, request, ...rest)
  }
}

/** Loads the tree's package natively, as the registry loads an external. */
function loadPackage(root: string, through: (load: () => unknown) => unknown): unknown {
  const entry = join(root, 'node_modules/pkg/index.js')
  return through(() => createRequire(entry)(entry))
}

test('a native load runs with the loader as found, and the patches are back after it', () => {
  const root = packageTree()
  patchLoader()
  const patched = {
    require: internals.prototype.require,
    load: internals._load,
    resolveFilename: internals._resolveFilename,
  }
  assert.deepEqual(loadPackage(root, withNodeLoader), {
    context: 'plain',
    aliased: 'installed',
    unknown: 'MODULE_NOT_FOUND',
  })
  assert.equal(internals.prototype.require, patched.require)
  assert.equal(internals._load, patched.load)
  assert.equal(internals._resolveFilename, patched.resolveFilename)
})

test('without it, the patches reach the native load (the control)', () => {
  const root = packageTree()
  patchLoader()
  assert.deepEqual(
    loadPackage(root, (load) => load()),
    { context: 'redirected', aliased: 'aliased', unknown: 'hooked' },
  )
})

test('a patch the load itself makes stays, and nothing is swapped when the loader is as found', () => {
  const own: Loader = function (this: unknown, request: string) {
    return original.require.call(this, request)
  }
  let during: unknown
  withNodeLoader(() => {
    during = internals.prototype.require
    internals.prototype.require = own
  })
  assert.equal(during, original.require)
  assert.equal(internals.prototype.require, own, 'the load’s own patch is kept')
})

test('a record the bin made first is the loader as found', () => {
  // The bin records the loader under the registered symbol before it reads a config; a loader
  // patched after that record and before this module loads is still not the one used.
  const nodeLoader = fileURLToPath(new URL('./node-loader.ts', import.meta.url))
  const source = `
    import Module, { createRequire } from 'node:module'
    const record = Object.freeze({
      require: Module.prototype.require,
      load: Module._load,
      resolveFilename: Module._resolveFilename,
    })
    Object.defineProperty(globalThis, Symbol.for('provino.nodeLoader'), { value: record })
    const require0 = Module.prototype.require
    Module.prototype.require = function (request) {
      return require0.call(this, request === 'node:path' ? 'node:os' : request)
    }
    const { withNodeLoader } = await import(${JSON.stringify(nodeLoader)})
    const here = createRequire(import.meta.url)
    const seen = withNodeLoader(() => typeof here('node:path').join)
    process.stdout.write(seen)
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, 'function')
})
