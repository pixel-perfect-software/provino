// What a test file's `process` is: the global, what each way of asking for the builtin returns,
// and the members a runner's copy of `process` replaces.
const EventEmitter = require('node:events')

test(`process is globalThis.process: ${process === globalThis.process}`, () => {})
test(`typeof process.on: ${typeof process.on}`, () => {})
test(`process is an EventEmitter: ${process instanceof EventEmitter}`, () => {})
test(`toString tag: ${Object.prototype.toString.call(process)}`, () => {})
// biome-ignore lint/style/useNodejsImportProtocol: the bare name is one of the ways asked about.
test(`require('process') is process: ${require('process') === process}`, () => {})
test(`require('node:process') is process: ${require('node:process') === process}`, () => {})
test(`process.getBuiltinModule('process') is process: ${process.getBuiltinModule('process') === process}`, () => {})
test(`process.getBuiltinModule('node:process') is process: ${process.getBuiltinModule('node:process') === process}`, () => {})
test(`typeof process.send: ${typeof process.send}`, () => {})
test(`process.send() returns: ${(process.send as () => unknown)()}`, () => {})
test(`process.features.require_module: ${(process.features as { require_module?: boolean }).require_module}`, () => {})
