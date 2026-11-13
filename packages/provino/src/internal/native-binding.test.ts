import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { type BindingProbe, bindingTriple, missingBindingMessage } from './native-binding.ts'

/** A machine, with the binding packages it can find (`present`, by full name). */
function machine(
  platform: string,
  arch: string,
  musl: boolean,
  present: readonly string[] = [],
): BindingProbe {
  return { platform, arch, musl, resolves: (_base, binding) => present.includes(binding) }
}

/** What `oxc-parser` throws when no binding loads: the long text, and the last package it tried. */
function oxcParserError(): Error {
  return new Error(
    'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.',
    { cause: new Error("Cannot find module '@oxc-parser/binding-wasm32-wasip1'") },
  )
}

/** All three Oxc packages' bindings for a platform, as a machine that has every one installed. */
function installed(platform: string, arch: string, musl: boolean): BindingProbe {
  const triple = bindingTriple(platform, arch, musl)
  return machine(
    platform,
    arch,
    musl,
    OXC.map((name) => `@${name}/binding-${triple}`),
  )
}

const OXC = ['oxc-parser', 'oxc-transform', 'oxc-resolver']

describe('bindingTriple', () => {
  it('names the platform as Oxc names its binding packages', () => {
    assert.equal(bindingTriple('darwin', 'arm64', false), 'darwin-arm64')
    assert.equal(bindingTriple('darwin', 'x64', false), 'darwin-x64')
    assert.equal(bindingTriple('win32', 'x64', false), 'win32-x64-msvc')
    assert.equal(bindingTriple('win32', 'arm64', false), 'win32-arm64-msvc')
    assert.equal(bindingTriple('linux', 'x64', false), 'linux-x64-gnu')
    assert.equal(bindingTriple('linux', 'x64', true), 'linux-x64-musl')
    assert.equal(bindingTriple('linux', 'arm64', true), 'linux-arm64-musl')
    assert.equal(bindingTriple('linux', 'arm', false), 'linux-arm-gnueabihf')
    assert.equal(bindingTriple('linux', 'arm', true), 'linux-arm-musleabihf')
    assert.equal(bindingTriple('android', 'arm', false), 'android-arm-eabi')
    assert.equal(bindingTriple('android', 'arm64', false), 'android-arm64')
    assert.equal(bindingTriple('freebsd', 'x64', false), 'freebsd-x64')
  })

  it("agrees with the installed Oxc packages' own binding names", () => {
    // Each `optionalDependencies` key is `@oxc-<name>/binding-<platform>-<arch>[-<libc>]`: read it
    // back into what Node reports and check the function names it as the package does.
    let checked = 0
    for (const name of OXC) {
      const path = createRequire(import.meta.url).resolve(`${name}/package.json`)
      const { optionalDependencies } = JSON.parse(readFileSync(path, 'utf8')) as {
        readonly optionalDependencies: Readonly<Record<string, string>>
      }
      for (const key of Object.keys(optionalDependencies)) {
        const suffix = key.slice(`@${name}/binding-`.length)
        const [platform = '', arch = '', libc = ''] = suffix.split('-')
        if (platform === 'wasm32') continue // the WebAssembly fallback, for no platform Node reports
        assert.equal(bindingTriple(platform, arch, libc.startsWith('musl')), suffix, key)
        checked++
      }
    }
    assert.ok(checked > 40, `${checked} binding packages checked`)
  })
})

describe('missingBindingMessage', () => {
  it("names this platform's package of all three Oxc packages when none is installed", () => {
    const message = missingBindingMessage(oxcParserError(), machine('darwin', 'arm64', false))
    assert.ok(message !== undefined)
    assert.match(message, /^Provino: the native Oxc binding for darwin arm64 is not installed/)
    assert.match(
      message,
      /Missing: @oxc-parser\/binding-darwin-arm64, @oxc-transform\/binding-darwin-arm64, @oxc-resolver\/binding-darwin-arm64\n/,
    )
    assert.match(message, /--omit=optional/)
    assert.match(message, /supportedArchitectures/)
    // Not the package oxc-parser itself last tried, and no stack.
    assert.doesNotMatch(message, /wasm32/)
    assert.doesNotMatch(message, /\n\s+at /)
  })

  it('names only the packages it cannot find', () => {
    const present = ['@oxc-parser/binding-linux-x64-gnu', '@oxc-transform/binding-linux-x64-gnu']
    const message = missingBindingMessage(oxcParserError(), machine('linux', 'x64', false, present))
    assert.match(message ?? '', /Missing: @oxc-resolver\/binding-linux-x64-gnu\n/)
    assert.doesNotMatch(message ?? '', /@oxc-parser\/binding-linux-x64-gnu/)
  })

  it('goes by the packages, whatever the error says', () => {
    // The three loaders word a missing binding three ways, and an error is only what the first
    // one tried: the install is what is wrong.
    const probe = machine('win32', 'x64', false)
    for (const error of [
      new Error("Cannot find module '@oxc-resolver/binding-win32-x64-msvc'"),
      new Error('wrapped', {
        cause: new Error("Cannot find module '@oxc-transform/binding-win32-x64-msvc'"),
      }),
      new Error('boom'),
      'a string',
      undefined,
    ]) {
      assert.match(missingBindingMessage(error, probe) ?? '', /@oxc-parser\/binding-win32-x64-msvc/)
    }
  })

  it('says the files are there when they are but did not load, and names all three', () => {
    const message = missingBindingMessage(
      new Error(
        'Cannot load the native binding: dlopen(/n/@oxc-parser/binding-linux-x64-musl/parser.linux-x64-musl.node, 1): image not found',
      ),
      installed('linux', 'x64', true),
    )
    assert.match(message ?? '', /for linux x64 \(musl\) is installed but did not load/)
    assert.match(message ?? '', /Check: @oxc-parser\/binding-linux-x64-musl, @oxc-transform\//)
  })

  it('reads a binding that did not load from its stack when the message only has the loader words', () => {
    const error = new Error('Failed to load: dlopen failed')
    error.stack =
      'Error: dlopen failed\n    at file:///p/node_modules/.pnpm/oxc-transform@0.157.0/node_modules/oxc-transform/index.js:762:19'
    assert.match(
      missingBindingMessage(error, installed('linux', 'x64', false)) ?? '',
      /installed but did not load/,
    )
  })

  it("leaves another napi-rs package's binding alone, with its own stack", () => {
    // swc, lightningcss and the rest ship the same loader, with the same words, and these
    // packages being found says the Oxc ones are fine.
    const probe = installed('darwin', 'arm64', false)
    const swc = new Error(
      'Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.',
      { cause: new Error("Cannot find module '@swc/core-darwin-arm64'") },
    )
    swc.stack =
      'Error: Cannot find native binding.\n    at Object.<anonymous> (/p/node_modules/.pnpm/@swc+core@1.16.22/node_modules/@swc/core/binding.js:333:11)'
    assert.equal(missingBindingMessage(swc, probe), undefined)
    const dlopen = new Error('dlopen(/p/node_modules/@swc/core-darwin-arm64/swc.darwin-arm64.node)')
    assert.equal(missingBindingMessage(dlopen, probe), undefined)
    const lightning = new Error("Cannot find module 'lightningcss-darwin-arm64'")
    assert.equal(missingBindingMessage(lightning, probe), undefined)
    assert.equal(missingBindingMessage(new Error('Cannot find native binding'), probe), undefined)
  })

  it('leaves an Oxc error that is not a binding failing to load alone', () => {
    const parse = new Error('Expected a semicolon')
    parse.stack =
      'Error: Expected a semicolon\n    at parseSync (/p/node_modules/.pnpm/oxc-parser@0.157.0/node_modules/oxc-parser/src-js/index.js:10:5)'
    assert.equal(missingBindingMessage(parse, installed('darwin', 'arm64', false)), undefined)
  })

  it('leaves every other error alone while the bindings are installed', () => {
    const probe = installed('darwin', 'arm64', false)
    for (const error of [
      new Error('boom'),
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      new Error("Cannot find module 'left-pad'"),
      'a string',
      undefined,
    ]) {
      assert.equal(missingBindingMessage(error, probe), undefined)
    }
  })
})
