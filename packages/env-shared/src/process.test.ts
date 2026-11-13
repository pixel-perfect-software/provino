// `createFileProcess`: the copy of `process` a test file gets under `processObject: 'per-file'`,
// with what Jest 30.5.2 recorded for its own copy (the harness's `env/process-*`).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import worker from 'node:process'
import { test } from 'node:test'
import { createFileProcess } from './process.ts'

test('the copy has the worker’s prototype, members and tag, and listeners of its own', () => {
  const copy = createFileProcess()
  assert.notEqual(copy, worker)
  assert.equal(Object.getPrototypeOf(copy), Object.getPrototypeOf(worker))
  assert.ok(copy instanceof EventEmitter)
  assert.equal(Object.prototype.toString.call(copy), '[object process]')
  assert.equal(copy.pid, worker.pid)
  assert.equal(copy.exit, worker.exit, 'acting on the process is the worker’s to do')
  assert.equal(copy.nextTick, worker.nextTick)
  assert.equal(copy.stdout, worker.stdout)
  assert.equal(copy.listenerCount('exit'), 0)
  assert.equal(copy.listenerCount('uncaughtException'), 0)
  let heard = 0
  const events = copy as unknown as EventEmitter
  events.on('provino-probe', () => void heard++)
  assert.equal(events.emit('provino-probe'), true)
  assert.equal(heard, 1)
  assert.equal(worker.listenerCount('provino-probe'), 0)
  assert.equal(createFileProcess().listenerCount('provino-probe'), 0, 'each copy starts empty')
})

test('nested values are copies: changing one reaches neither the worker nor the next copy', () => {
  const copy = createFileProcess()
  assert.deepEqual(copy.argv, worker.argv)
  copy.argv.push('--added-by-a-test')
  assert.equal(worker.argv.includes('--added-by-a-test'), false)
  assert.deepEqual(copy.versions, worker.versions)
  assert.notEqual(copy.versions, worker.versions)
  assert.equal(copy.versions, copy.versions, 'read-only objects are copied once, on first read')
  assert.deepEqual(copy.config, worker.config)
  assert.equal(createFileProcess().argv.includes('--added-by-a-test'), false)
})

test('env is a copy that keeps strings, and leaves the worker’s alone', () => {
  const copy = createFileProcess()
  assert.deepEqual({ ...copy.env }, { ...worker.env })
  const env = copy.env as Record<string, unknown>
  env.PROVINO_PROCESS_COPY = 42
  assert.equal(env.PROVINO_PROCESS_COPY, '42')
  assert.ok(Object.keys(env).includes('PROVINO_PROCESS_COPY'))
  assert.equal(worker.env.PROVINO_PROCESS_COPY, undefined)
  delete env.PROVINO_PROCESS_COPY
  assert.equal('PROVINO_PROCESS_COPY' in env, false)
})

test('send does nothing, domain is the worker’s, and getBuiltinModule("process") is the copy', () => {
  const copy = createFileProcess()
  assert.equal((copy.send as () => unknown)(), true)
  const domainOf = (target: object): unknown => Reflect.get(target, 'domain')
  assert.equal(domainOf(copy), domainOf(worker))
  assert.equal(copy.getBuiltinModule('process'), copy)
  assert.equal(copy.getBuiltinModule('node:process'), copy)
  assert.equal(copy.getBuiltinModule('node:path'), worker.getBuiltinModule('node:path'))
  assert.equal(Object.hasOwn(copy, 'mainModule'), false)
})
