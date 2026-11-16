// `markAsyncGraphs` is incremental (it looks only at the records whose inputs changed and walks the
// importers of one that gained a flag): these hold its flags equal to a scan of every record to a
// fixed point, the rule as it was first written, on named shapes (cycles, a top-level-await leaf
// reached through a cycle, late deps, a dropped module made again) and on seeded random graphs
// linked in random order.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HoistPolicy } from '@provino/types'
import {
  createRecords,
  dropRecords,
  linkSync,
  type ModuleRecord,
  type Records,
  recordFor,
  toModuleId,
} from './records.ts'
import { loaderOptionsFor, writeTree } from './test-support.ts'

/** A hoist policy that makes a file's imports late when it calls `mocker.mock` (D38). */
const HOIST: HoistPolicy = {
  id: 'async-graphs-test',
  objects: [{ kind: 'global', name: 'mocker' }],
  hoistCalls: { mock: 'path-factory-options', unmock: 'one-string' },
  hoistValues: [],
  rewriteImportArg: [],
  chainable: true,
  placement: 'enclosing-block',
  topLevelGuards: [],
  factoryReferences: 'allow',
  runnerModules: [],
  reExports: 'in-order',
  rewrittenCalls: 'detached',
  messages: {
    HOIST_FACTORY_OUT_OF_SCOPE: 'out of scope',
    HOIST_FACTORY_NOT_FUNCTION: 'not a function',
    HOIST_NOT_TOP_LEVEL: 'not top level',
    HOIST_NESTED: 'nested',
    HOIST_EXPORTED: 'exported',
    HOIST_EXPORTED_VALUE: 'exported value',
  },
}

/**
 * The reference: every record's own flags, then a scan of every linked record over its `user`
 * targets until nothing changes (what `markAsyncGraphs` did before it was incremental).
 */
function expectedFlags(state: Records): Map<string, { async: boolean; late: boolean }> {
  const flags = new Map<string, { async: boolean; late: boolean }>()
  for (const record of state.records.values()) {
    flags.set(record.id, { async: record.hasTopLevelAwait, late: record.lateDeps.length > 0 })
  }
  let changed = true
  while (changed) {
    changed = false
    for (const record of state.records.values()) {
      if (!record.linked) continue
      const own = flags.get(record.id)
      if (own === undefined) continue
      for (const target of record.resolved.values()) {
        const dep = target.kind === 'user' ? flags.get(target.id) : undefined
        if (dep === undefined) continue
        if (dep.async && !own.async) {
          own.async = true
          changed = true
        }
        if (dep.late && !own.late) {
          own.late = true
          changed = true
        }
      }
    }
  }
  return flags
}

function assertFlags(state: Records, what: string): void {
  const expected = expectedFlags(state)
  for (const record of state.records.values()) {
    assert.deepEqual(
      { async: record.asyncGraph, late: record.lateGraph },
      expected.get(record.id),
      `${what}: ${record.path}`,
    )
  }
}

function recordsOf(root: string): Records {
  return createRecords(loaderOptionsFor(root, { hoist: HOIST }))
}

function link(state: Records, root: string, file: string): ModuleRecord {
  const record = recordFor(state, toModuleId(join(root, file)), false)
  linkSync(state, record)
  return record
}

function flagsOf(state: Records, root: string, file: string): { async: boolean; late: boolean } {
  const record = state.records.get(toModuleId(join(root, file)))
  assert.ok(record !== undefined, `${file} has a record`)
  return { async: record.asyncGraph, late: record.lateGraph }
}

test('a top-level-await leaf reached through a cycle marks every module of the cycle and above it', () => {
  const root = writeTree({
    'top.ts': "import './a.ts'\nexport const top = 1\n",
    'a.ts': "import './b.ts'\nexport const a = 1\n",
    'b.ts': "import './c.ts'\nexport const b = 1\n",
    'c.ts': "import './a.ts'\nimport './leaf.ts'\nexport const c = 1\n",
    'leaf.ts': 'await Promise.resolve()\nexport const leaf = 1\n',
    'apart.ts': 'export const apart = 1\n',
  })
  const state = recordsOf(root)
  link(state, root, 'top.ts')
  link(state, root, 'apart.ts')
  for (const file of ['top.ts', 'a.ts', 'b.ts', 'c.ts', 'leaf.ts']) {
    assert.deepEqual(flagsOf(state, root, file), { async: true, late: false }, file)
  }
  assert.deepEqual(flagsOf(state, root, 'apart.ts'), { async: false, late: false })
  assertFlags(state, 'cycle')
})

test('late deps mark their importers through a cycle, and a cycle with neither stays unmarked', () => {
  const root = writeTree({
    'x.ts': "import './y.ts'\nexport const x = 1\n",
    'y.ts': "import './x.ts'\nimport './hoists.ts'\nexport const y = 1\n",
    'hoists.ts': "import { d } from './d.ts'\nmocker.mock('./d.ts')\nexport const h = d\n",
    'd.ts': 'export const d = 1\n',
    'p.ts': "import './q.ts'\nexport const p = 1\n",
    'q.ts': "import './p.ts'\nexport const q = 1\n",
  })
  const state = recordsOf(root)
  link(state, root, 'x.ts')
  link(state, root, 'p.ts')
  const hoists = state.records.get(toModuleId(join(root, 'hoists.ts')))
  assert.deepEqual(hoists?.lateDeps, ['./d.ts'], 'the hoister made the import late')
  for (const file of ['x.ts', 'y.ts', 'hoists.ts']) {
    assert.deepEqual(flagsOf(state, root, file), { async: false, late: true }, file)
  }
  // A late dep is never linked: it has no record yet, and adds nothing.
  assert.equal(state.records.has(toModuleId(join(root, 'd.ts'))), false)
  for (const file of ['p.ts', 'q.ts']) {
    assert.deepEqual(flagsOf(state, root, file), { async: false, late: false }, file)
  }
  assertFlags(state, 'late')
})

test('a module linked after its importer marks the importer, however late it is linked', () => {
  const root = writeTree({
    'a.ts': "import './b.ts'\nexport const a = 1\n",
    'b.ts': "import './c.ts'\nexport const b = 1\n",
    'c.ts': 'export const c = await Promise.resolve(1)\n',
  })
  const state = recordsOf(root)
  // The leaf first, then each importer in turn: each link reads a dep marked by an earlier one.
  link(state, root, 'c.ts')
  assert.deepEqual(flagsOf(state, root, 'c.ts'), { async: true, late: false })
  link(state, root, 'b.ts')
  link(state, root, 'a.ts')
  assert.deepEqual(flagsOf(state, root, 'a.ts'), { async: true, late: false })
  assertFlags(state, 'bottom-up')
})

test('a dropped module made again with top-level await marks the modules that import it', () => {
  const files = {
    'a.ts': "import './b.ts'\nexport const a = 1\n",
    'b.ts': 'export const b = 1\n',
  }
  const root = writeTree(files)
  const state = recordsOf(root)
  link(state, root, 'a.ts')
  assert.deepEqual(flagsOf(state, root, 'a.ts'), { async: false, late: false })
  writeFileSync(join(root, 'b.ts'), 'export const b = await Promise.resolve(2)\n')
  dropRecords(state, [join(root, 'b.ts')])
  // The next link of anything that reaches it reads, transforms and marks it again.
  link(state, root, 'b.ts')
  assert.deepEqual(flagsOf(state, root, 'b.ts'), { async: true, late: false })
  assert.deepEqual(flagsOf(state, root, 'a.ts'), { async: true, late: false })
  assertFlags(state, 'drop')
})

/** A small seeded generator (mulberry32), so a failing graph is the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('on seeded random graphs linked in random order, the flags are a full scan’s after every link', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const next = random(seed)
    const count = 6 + Math.floor(next() * 14)
    const name = (index: number): string => `m${index}.ts`
    const files: Record<string, string> = {}
    for (let index = 0; index < count; index++) {
      const lines: string[] = []
      const deps = Math.floor(next() * 4)
      for (let dep = 0; dep < deps; dep++) {
        // Any module, before or after this one: cycles, self-imports and diamonds all come up.
        lines.push(`import './${name(Math.floor(next() * count))}'`)
      }
      const roll = next()
      if (roll < 0.12) lines.push('await Promise.resolve()')
      else if (roll < 0.24) {
        lines.push(`import './late${index}.ts'`, `mocker.mock('./late${index}.ts')`)
        files[`late${index}.ts`] = 'export const late = 1\n'
      }
      lines.push(`export const v${index} = ${index}`, '')
      files[name(index)] = lines.join('\n')
    }
    const root = writeTree(files)
    const state = recordsOf(root)
    const order = Array.from({ length: count }, (_, index) => index)
    for (let index = order.length - 1; index > 0; index--) {
      const other = Math.floor(next() * (index + 1))
      ;[order[index], order[other]] = [order[other] ?? 0, order[index] ?? 0]
    }
    for (const index of order) {
      link(state, root, name(index))
      assertFlags(state, `seed ${seed}, after linking ${name(index)}`)
    }
  }
})
