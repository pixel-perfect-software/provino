import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { test } from 'provino'
import { generateWatchTree } from './generate.ts'

test('the full tree is 5,000 files in 600 directories, 500 of them tests over chains of 9', () => {
  const tree = generateWatchTree()
  assert.equal(tree.files.size, 5_000)
  assert.equal(tree.tests, 500)
  assert.equal(tree.chainLength, 9)
  assert.equal(tree.directories, 600)
  const dirs = new Set([...tree.files.keys()].map((path) => posix.dirname(path)))
  assert.equal(dirs.size, 600)
  assert.equal([...tree.files.keys()].filter((path) => path.endsWith('.test.ts')).length, 500)
  assert.ok([...tree.files.keys()].every((path) => path.endsWith('.ts')))
})

test('the same seed gives the same bytes, another seed gives other ones', () => {
  const a = generateWatchTree({ files: 200, seed: 7 })
  const b = generateWatchTree({ files: 200, seed: 7 })
  const c = generateWatchTree({ files: 200, seed: 8 })
  assert.deepEqual([...a.files], [...b.files])
  assert.notDeepEqual([...a.files], [...c.files])
})

test('every require resolves to a file of the tree, and each chain ends in its leaf', () => {
  const tree = generateWatchTree({ files: 120 })
  const required = new Set<string>()
  for (const [path, text] of tree.files) {
    for (const match of text.matchAll(/require\('([^']+)'\)/g)) {
      const target = `${posix.normalize(posix.join(posix.dirname(path), match[1] ?? ''))}.ts`
      assert.ok(tree.files.has(target), `${path} requires ${target}`)
      required.add(target)
    }
  }
  // Every module is required by the one above it (or by its test): nothing is left over.
  assert.equal(required.size, tree.files.size - tree.tests)
  assert.ok(tree.files.has(tree.leaf))
  assert.doesNotMatch(tree.files.get(tree.leaf) ?? '', /require/)
  assert.ok(tree.leafTest.endsWith('.test.ts'))
})

test('a test expects the value its chain evaluates to, under every save text', () => {
  const tree = generateWatchTree({ files: 60, seed: 3 })
  const resolve = (from: string, to: string): string =>
    `${posix.normalize(posix.join(posix.dirname(from), to))}.ts`
  const chainValue = (path: string): number => {
    const text = path === tree.leaf ? tree.leafText(5) : (tree.files.get(path) ?? '')
    const own = Number(/^exports\.value = (\d+)/.exec(text)?.[1])
    const below = /require\('([^']+)'\)/.exec(text)?.[1]
    return below === undefined ? own : own + chainValue(resolve(path, below))
  }
  let checked = 0
  for (const [path, text] of tree.files) {
    if (!path.endsWith('.test.ts')) continue
    const head = /require\('([^']+)'\)/.exec(text)?.[1] ?? ''
    const expected = Number(/toBe\((\d+)\)/.exec(text)?.[1])
    assert.equal(chainValue(resolve(path, head)), expected)
    checked++
  }
  assert.equal(checked, tree.tests)
  const committed = tree.leafText(0)
  assert.match(committed, /^exports\.value = \d+\n$/)
  assert.equal(tree.leafText(3).split('\n')[0], committed.split('\n')[0])
  assert.notEqual(tree.leafText(3), tree.leafText(4))
})

test('a small tree still has a test, a chain and a leaf', () => {
  const tree = generateWatchTree({ files: 2 })
  assert.equal(tree.tests, 1)
  assert.equal(tree.chainLength, 1)
  assert.equal(tree.files.size, 2)
  assert.throws(() => generateWatchTree({ files: 1 }), RangeError)
})
