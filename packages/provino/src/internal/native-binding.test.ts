import assert from 'node:assert/strict'
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
    assert.equal(bindingTriple('freebsd', 'x64', false), 'freebsd-x64')
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

  it('says the files are there when they are but did not load, and names all three', () => {
    const all = ['parser', 'transform', 'resolver'].map(
      (name) => `@oxc-${name}/binding-linux-x64-musl`,
    )
    const message = missingBindingMessage(oxcParserError(), machine('linux', 'x64', true, all))
    assert.match(message ?? '', /for linux x64 \(musl\) is installed but did not load/)
    assert.match(message ?? '', /Check: @oxc-parser\/binding-linux-x64-musl, @oxc-transform\//)
  })

  it('reads the failure however the three packages word it', () => {
    const probe = machine('win32', 'x64', false)
    for (const error of [
      new Error("Cannot find module '@oxc-resolver/binding-win32-x64-msvc'"),
      new Error('wrapped', {
        cause: new Error("Cannot find module '@oxc-transform/binding-win32-x64-msvc'"),
      }),
      new Error(
        'Cannot load the native binding: dlopen(/n/@oxc-parser/binding-win32-x64-msvc/parser.win32-x64-msvc.node, 1): image not found',
      ),
    ]) {
      assert.match(missingBindingMessage(error, probe) ?? '', /@oxc-parser\/binding-win32-x64-msvc/)
    }
  })

  it('leaves every other error alone', () => {
    const probe = machine('darwin', 'arm64', false)
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
