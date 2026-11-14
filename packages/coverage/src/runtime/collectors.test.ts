// T8.8: the worker's collectors. Istanbul's takes copy the counters and zero them where they are,
// send a file's maps once, and the coordinator's `expandIstanbulData` puts them back; V8's take
// keeps the scripts the loader compiled and the filter counts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import type { IstanbulFileCoverageData } from '@provino/types'
import { createIstanbulCollector } from './istanbul-collector.ts'
import { createV8Collector } from './v8-collector.ts'

function fileData(path: string, hits: number): IstanbulFileCoverageData {
  const at = { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }
  return {
    path,
    statementMap: { '0': at },
    fnMap: { '0': { name: 'f', decl: at, loc: at } },
    branchMap: { '0': { type: 'if', locations: [at, at] } },
    s: { '0': hits },
    f: { '0': hits },
    b: { '0': [hits, 0] },
    hash: 'h1',
  }
}

test('istanbul: a take copies the counters, zeroes them in place and sends the maps once', async () => {
  const variable = '__provino_test_coverage__'
  const live = fileData('/p/a.ts', 3)
  Reflect.set(globalThis, variable, { '/p/a.ts': live })
  try {
    const collector = createIstanbulCollector({ workerId: 1, variable })
    const first = await collector.take('/p/a.test.ts')
    assert.equal(first.kind, 'istanbul')
    if (first.kind !== 'istanbul') return
    const sent = first.data['/p/a.ts'] as IstanbulFileCoverageData
    assert.deepEqual(sent.s, { '0': 3 })
    assert.ok('statementMap' in sent)
    // Zero in the object the instrumented code holds, which is still the same object.
    assert.equal(Reflect.get(Reflect.get(globalThis, variable) as object, '/p/a.ts'), live)
    assert.deepEqual(live.s, { '0': 0 })
    assert.deepEqual(live.b, { '0': [0, 0] })

    // The next file counts again: counters only this time.
    ;(live.s as Record<string, number>)['0'] = 2
    const second = await collector.take('/p/b.test.ts')
    assert.equal(second.kind, 'istanbul')
    if (second.kind !== 'istanbul') return
    const later = second.data['/p/a.ts'] as Record<string, unknown>
    assert.equal('statementMap' in later, false)
    assert.deepEqual(later.s, { '0': 2 })

    // Nothing counted and the maps already sent: nothing to send.
    const third = await collector.take()
    assert.deepEqual(third.kind === 'istanbul' ? third.data : null, {})
  } finally {
    Reflect.deleteProperty(globalThis, variable)
  }
})

test('istanbul: once a file has been sent, a take copies no map for it', async () => {
  const variable = '__provino_test_coverage_clones__'
  const live = fileData('/p/a.ts', 1)
  Reflect.set(globalThis, variable, { '/p/a.ts': live })
  const original = globalThis.structuredClone
  const cloned: unknown[] = []
  try {
    const collector = createIstanbulCollector({ workerId: 1, variable })
    await collector.take('/p/a.test.ts')
    globalThis.structuredClone = ((
      value: unknown,
      options?: Parameters<typeof structuredClone>[1],
    ) => {
      cloned.push(value)
      return original(value, options)
    }) as typeof structuredClone
    // Untouched, maps sent: nothing is copied and nothing is sent.
    const idle = await collector.take('/p/b.test.ts')
    assert.deepEqual(idle.kind === 'istanbul' ? idle.data : null, {})
    assert.deepEqual(cloned, [])
    // Touched: only the counters are copied.
    ;(live.s as Record<string, number>)['0'] = 4
    const busy = await collector.take('/p/c.test.ts')
    assert.deepEqual(busy.kind === 'istanbul' ? busy.data['/p/a.ts'] : null, {
      path: '/p/a.ts',
      hash: 'h1',
      s: { '0': 4 },
      f: { '0': 0 },
      b: { '0': [0, 0] },
    })
    assert.equal(cloned.length, 1)
    for (const value of cloned) {
      assert.deepEqual(Object.keys(value as object).sort(), ['b', 'f', 's'])
    }
  } finally {
    globalThis.structuredClone = original
    Reflect.deleteProperty(globalThis, variable)
  }
})

test('v8: a take keeps the compiled, counted user modules, their wrapper lengths and code', async () => {
  const path = `${process.cwd()}/provino-v8-collector-fixture-a.ts`
  const other = `${process.cwd()}/provino-v8-collector-fixture-b.ts`
  const collector = createV8Collector({
    workerId: 7,
    loader: {
      compiledModule: (url) =>
        url === pathToFileURL(path).href || url === pathToFileURL(other).href
          ? {
              path: url === pathToFileURL(path).href ? path : other,
              code: `code of ${url}`,
              wrapperLength: 4,
              map: null,
              transformKey: `key:${url}`,
            }
          : null,
    },
    include: (file) => file === path,
    callCount: true,
  })
  await collector.start()
  try {
    // `file:` URLs are what V8 reports for a script given a path as its filename.
    runInThisContext('(function () { return 1 })()', { filename: path })
    runInThisContext('(function () { return 2 })()', { filename: other })
    const raw = await collector.take('/p/a.test.ts')
    assert.equal(raw.kind, 'v8')
    if (raw.kind !== 'v8') return
    assert.equal(raw.workerId, 7)
    assert.equal(raw.testFile, '/p/a.test.ts')
    assert.deepEqual(
      raw.scripts.map((script) => script.url),
      [pathToFileURL(path).href],
    )
    assert.deepEqual(raw.modules, [
      {
        url: pathToFileURL(path).href,
        wrapperLength: 4,
        transformKey: `key:${pathToFileURL(path).href}`,
        // The code V8 counted and its map go with it: the coordinator converts from them.
        code: `code of ${pathToFileURL(path).href}`,
        map: null,
      },
    ])
  } finally {
    await collector.stop()
  }
})
