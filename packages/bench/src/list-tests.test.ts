import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCli } from './cli-args.ts'
import { runCli } from './commands.ts'
import { compareLists, listTestsCommand, parseList } from './list-tests.ts'

describe('compareLists', () => {
  it('compares as sets, in any order', () => {
    assert.deepEqual(compareLists(['/a', '/b', '/c'], ['/c', '/a', '/b']), {
      equal: true,
      common: 3,
      onlyJest: [],
      onlyProvino: [],
    })
  })

  it('names what only one side lists, sorted', () => {
    const comparison = compareLists(['/a', '/z', '/b'], ['/a', '/y', '/b'])
    assert.equal(comparison.equal, false)
    assert.equal(comparison.common, 2)
    assert.deepEqual(comparison.onlyJest, ['/z'])
    assert.deepEqual(comparison.onlyProvino, ['/y'])
  })
})

describe('parseList', () => {
  it('reads the JSON array on its own line, after any warning', () => {
    assert.deepEqual(parseList('jest', 'warning: x\n["/a","/b"]\n'), ['/a', '/b'])
    assert.deepEqual(parseList('jest', '[]\n'), [])
  })

  it('rejects output that is not a list of paths', () => {
    assert.throws(() => parseList('provino', 'no tests\n'), { code: 'BENCH_EXEC_FAILED' })
    assert.throws(() => parseList('provino', '[1,2]\n'), { code: 'BENCH_EXEC_FAILED' })
  })
})

describe('list-tests command', () => {
  const capture = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
      out,
      err,
    }
  }

  it('parses a project directory, and refuses a missing one and options it does not read', () => {
    assert.deepEqual(parseCli(['list-tests', '/repo']), { command: 'list-tests', dir: '/repo' })
    assert.throws(() => parseCli(['list-tests']), { code: 'BENCH_USAGE' })
    assert.throws(() => parseCli(['list-tests', '/repo', '--warm', '3']), { code: 'BENCH_USAGE' })
  })

  it('exits 0 when the lists are one set, and prints the counts', async () => {
    const { io, out } = capture()
    const code = await listTestsCommand('/repo', io, async () => ({
      jest: ['/a', '/b'],
      provino: ['/b', '/a'],
    }))
    assert.equal(code, 0)
    assert.match(out.join('\n'), /jest: 2 test files, provino: 2/)
    assert.match(out.join('\n'), /the lists are the same set/)
  })

  it('exits 1 and names the difference when they differ', async () => {
    const { io, out } = capture()
    const code = await listTestsCommand('/repo', io, async () => ({
      jest: ['/a', '/b'],
      provino: ['/a'],
    }))
    assert.equal(code, 1)
    assert.match(out.join('\n'), /only jest:\s+\/b/)
  })

  it('is a command of the bench CLI', async () => {
    const { io, out } = capture()
    const code = await runCli(['list-tests', '/repo'], io, {
      readLists: async () => ({ jest: ['/a'], provino: ['/a'] }),
    })
    assert.equal(code, 0)
    assert.match(out.join('\n'), /the lists are the same set/)
  })
})
