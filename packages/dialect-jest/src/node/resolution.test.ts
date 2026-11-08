// A custom `resolver` module is loaded once (jest-resolve's `preloadResolver`): its code runs one
// time, a module with only named `sync`/`async` exports is a resolver as its namespace is, and
// resolution then goes through it.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { oracleRequireResolve, removeTree, writeTree } from './internal/test-support.ts'
import { createJestResolution } from './resolution.ts'

const trees: string[] = []
after(() => {
  for (const tree of trees) removeTree(tree)
})

test('a resolver with only named exports is loaded once and used', async () => {
  const root = writeTree({
    'resolver.mjs': `globalThis.__provinoResolverLoads = (globalThis.__provinoResolverLoads ?? 0) + 1
export function sync(path, options) {
  return options.defaultResolver(path === 'alias' ? './target.js' : path, options)
}
`,
    'target.js': '',
  })
  trees.push(root)
  Reflect.set(globalThis, '__provinoResolverLoads', 0)
  const resolution = createJestResolution(oracleRequireResolve)
  const resolver = join(root, 'resolver.mjs')
  await resolution.preloadResolver(resolver)
  await resolution.preloadResolver(resolver)
  assert.equal(Reflect.get(globalThis, '__provinoResolverLoads'), 1)
  assert.equal(
    resolution.findNodeModule('alias', { basedir: root, resolver }),
    join(root, 'target.js'),
  )
})

test('a CommonJS resolver function is the resolver', async () => {
  const root = writeTree({
    'resolver.js':
      "module.exports = (path, options) => options.defaultResolver(path.replace(/^@@/, './'), options)\n",
    'x.js': '',
  })
  trees.push(root)
  const resolution = createJestResolution(oracleRequireResolve)
  const resolver = join(root, 'resolver.js')
  await resolution.preloadResolver(resolver)
  assert.equal(resolution.findNodeModule('@@x.js', { basedir: root, resolver }), join(root, 'x.js'))
})

test("a module that exports no resolver is refused with jest-resolve's text", async () => {
  const root = writeTree({ 'resolver.mjs': 'export const nothing = 1\n' })
  trees.push(root)
  const resolver = join(root, 'resolver.mjs')
  await assert.rejects(createJestResolution(oracleRequireResolve).preloadResolver(resolver), {
    code: 'JEST_CONFIG_LOAD_FAILED',
    message: `Resolver located at ${resolver} does not export a function or an object with "sync" and "async" props`,
  })
})
