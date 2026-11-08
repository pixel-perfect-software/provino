import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateLayouts } from './generate.ts'
import { type RunnerName, runRecorded } from './run-recorded.ts'

async function logOf(code: string, runner: RunnerName = 'jest'): Promise<readonly string[]> {
  const log = await runRecorded(code, runner)
  assert.equal(log.compileError, undefined)
  return log.lines
}

test('a free name is read, called and logged, with no setup', async () => {
  assert.deepEqual(await logOf('foo(1, "a")'), [
    'read global foo',
    'call global.foo(1, "a") this=<global>',
    'body done',
  ])
})

test('a mock call is logged with its arguments, and a factory runs at the load that needs it', async () => {
  assert.deepEqual(
    await logOf('jest.mock("./a", () => ({ v: 1 }), { virtual: true })\nconst a = require("./a")'),
    [
      'jest.mock("./a", fn/0, {virtual: true})',
      'load ./a [factory]',
      'factory ./a start',
      'factory ./a returned {v: 1}',
      'body done',
    ],
  )
})

test('a factory that reads a const in its dead zone throws, and the run says so', async () => {
  assert.deepEqual(
    await logOf('jest.mock("./a", () => c)\nconst m = require("./a")\nconst c = 1\nuse(m)'),
    [
      'jest.mock("./a", fn/0)',
      'load ./a [factory]',
      'factory ./a start',
      'factory ./a threw ReferenceError',
      'body threw ReferenceError',
    ],
  )
})

test('the load order and the mock state at each load are in the log', async () => {
  const mockFirst = await logOf('jest.mock("./a")\nrequire("./a")')
  const loadFirst = await logOf('require("./a")\njest.mock("./a")')
  assert.deepEqual(mockFirst, ['jest.mock("./a")', 'load ./a [automock]', 'body done'])
  assert.deepEqual(loadFirst, ['load ./a [real]', 'jest.mock("./a")', 'body done'])
})

test('a second load is a cache hit, until a mock call changes the module', async () => {
  assert.deepEqual(await logOf('require("./a")\nrequire("./a")'), ['load ./a [real]', 'body done'])
  assert.deepEqual(await logOf('require("./a")\njest.doMock("./a")\nrequire("./a")'), [
    'load ./a [real]',
    'jest.doMock("./a")',
    'load ./a [automock]',
    'body done',
  ])
})

test('the `this` of a call through a namespace shows', async () => {
  const lines = await logOf('const n = require("./a")\nn.f()\n;(0, n.f)()')
  assert.deepEqual(lines, [
    'load ./a [real]',
    'read ./a.f',
    'call ./a.f() this=<ns:./a>',
    'read ./a.f',
    'call ./a.f() this=undefined',
    'body done',
  ])
})

test('a live export moves between the two reads, and a frozen one does not', async () => {
  const live = await logOf(
    'const n = require("./x")\nObject.defineProperty(exports, "y", { enumerable: true, get() { return n.x } })',
  )
  assert.ok(live.includes('export first y = <./x.x>'))
  assert.ok(live.includes('export live y = <./x.x@2>'))
  const frozen = await logOf('const n = require("./x")\nexports.y = n.x')
  assert.ok(frozen.includes('export first y = <./x.x>'))
  assert.ok(frozen.includes('export live y = <./x.x>'))
})

test('an exported function and a callback run after the body, so a stale name in one shows', async () => {
  const lines = await logOf('exports.f = function () { return stale }\ntest("t", () => other)')
  assert.deepEqual(lines, [
    'read global test',
    'call global.test("t", fn/0) this=<global>',
    'body done',
    'export first f = fn/0',
    'export live f = fn/0',
    'read global stale',
    'exported f() returned <global.stale>',
    'read global other',
    'callback global.test[1] returned <global.other>',
  ])
})

test('a factory no load asked for still runs, after the body', async () => {
  assert.deepEqual(await logOf('jest.mock("./a", () => mockX)'), [
    'jest.mock("./a", fn/0)',
    'body done',
    'factory ./a start',
    'read global mockX',
    'factory ./a returned <global.mockX>',
  ])
})

test('each runner has its own object and its own modules', async () => {
  assert.deepEqual(await logOf('vi.mock("./a")', 'vitest'), ['vi.mock("./a")', 'body done'])
  assert.deepEqual(await logOf('vitest.mock("./a")', 'vitest'), ['vitest.mock("./a")', 'body done'])
  assert.deepEqual(await logOf('vi.mock("./a")', 'jest'), [
    'read global vi',
    'read global.vi.mock',
    'call global.vi.mock("./a") this=<global.vi>',
    'body done',
  ])
  assert.deepEqual(await logOf('const g = require("@jest/globals")\ng.jest.mock("./a")'), [
    'jest.mock("./a")',
    'body done',
  ])
})

test('vi.hoisted runs its function and hands back the value', async () => {
  assert.deepEqual(await logOf('const h = vi.hoisted(() => 1)\nuse(h)', 'vitest'), [
    'vi.hoisted(fn/0)',
    'read global use',
    'call global.use(1) this=<global>',
    'body done',
  ])
})

test('the module-runner names work: imports, dynamic imports with options, and export *', async () => {
  const log = await runRecorded(
    [
      'const a = await __vite_ssr_import__("./a", { importedNames: ["x"] })',
      'const j = await __vite_ssr_dynamic_import__("./j.json", { with: { type: "json" } })',
      '__vite_ssr_exportAll__(a)',
    ].join('\n'),
    'vitest',
  )
  assert.deepEqual(log.loadOptions, ['./j.json {"with":{"type":"json"}}'])
  assert.deepEqual(log.lines.slice(0, 2), ['load ./a [real]', 'load ./j.json [real]'])
  assert.ok(log.lines.includes('export first a = <./a.a>'))
  assert.ok(log.lines.includes('export live b = <./a.b@2>'))
  assert.ok(!log.lines.some((line) => line.includes('export first default')))
})

test('code that does not compile is reported, and a runaway loop stops at the cap', async () => {
  const broken = await runRecorded('const = 1', 'jest')
  assert.notEqual(broken.compileError, undefined)
  assert.deepEqual(broken.lines, [])
  const runaway = await runRecorded('while (stay()) {}', 'jest')
  assert.equal(runaway.truncated, true)
})

test('a run shares nothing with the one before', async () => {
  const code = 'jest.mock("./a")\nrequire("./a")'
  assert.deepEqual(await logOf(code), await logOf(code))
  assert.deepEqual(await logOf('require("./a")'), ['load ./a [real]', 'body done'])
})

test('generated layouts are the same every time, and differ by seed', () => {
  const first = generateLayouts('jest', 50, 1)
  assert.deepEqual(first, generateLayouts('jest', 50, 1))
  assert.notDeepEqual(first, generateLayouts('jest', 50, 2))
  assert.notDeepEqual(
    generateLayouts('vitest', 50, 1).map((c) => c.code),
    first.map((c) => c.code),
  )
})
