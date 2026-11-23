// B25c: the alias cases of @rollup/plugin-alias (the plugin Vite runs `resolve.alias` through),
// as its own tests state them: string prefix with a slash boundary, RegExp find with captures,
// first match wins, and the order of the entries.
import assert from 'node:assert/strict'
import type { ModuleMapper, ResolveContext } from '@provino/types'
import { test } from 'provino'
import { createViteAliasMapper, viteAliasMapper } from './vite-alias.ts'

const context: ResolveContext = { importer: '/p/a.ts', kind: 'import', conditions: ['node'] }

function candidate(mapper: ModuleMapper, specifier: string): string | null {
  return mapper.map(specifier, context)?.candidates[0] ?? null
}

test('a string find matches itself and a path under it, not a longer name', () => {
  const mapper = createViteAliasMapper({ aliases: [{ find: '@', replacement: '/p/src' }] })
  assert.equal(candidate(mapper, '@'), '/p/src')
  assert.equal(candidate(mapper, '@/utils/x'), '/p/src/utils/x')
  assert.equal(candidate(mapper, '@scope/pkg'), null)
  assert.equal(candidate(mapper, 'lib/@/x'), null)
})

test('a string find replaces only the prefix', () => {
  const mapper = createViteAliasMapper({ aliases: [{ find: 'utils', replacement: '/p/lib' }] })
  assert.equal(candidate(mapper, 'utils/utils'), '/p/lib/utils')
})

test('a RegExp find replaces the match, with captures', () => {
  const mapper = createViteAliasMapper({
    aliases: [{ find: { source: '^~(.*)$', flags: '' }, replacement: '/p/src$1' }],
  })
  assert.equal(candidate(mapper, '~/a/b'), '/p/src/a/b')
  assert.equal(candidate(mapper, 'a~/b'), null)
})

test('an unanchored RegExp replaces where it matches, and flags apply', () => {
  const mapper = createViteAliasMapper({
    aliases: [{ find: { source: 'LIB', flags: 'i' }, replacement: 'lib2' }],
  })
  assert.equal(candidate(mapper, 'my-lib/x'), 'my-lib2/x')
  const global = createViteAliasMapper({
    aliases: [{ find: { source: 'a', flags: 'g' }, replacement: 'b' }],
  })
  // The test is stateless under `g`, and the replace is global.
  assert.equal(candidate(global, 'aaa'), 'bbb')
  assert.equal(candidate(global, 'aaa'), 'bbb')
})

test('the first matching entry decides, in order', () => {
  const mapper = createViteAliasMapper({
    aliases: [
      { find: '@/special', replacement: '/p/special' },
      { find: '@', replacement: '/p/src' },
    ],
  })
  assert.equal(candidate(mapper, '@/special/a'), '/p/special/a')
  assert.equal(candidate(mapper, '@/other'), '/p/src/other')
  const reversed = createViteAliasMapper({
    aliases: [
      { find: '@', replacement: '/p/src' },
      { find: '@/special', replacement: '/p/special' },
    ],
  })
  assert.equal(candidate(reversed, '@/special/a'), '/p/src/special/a')
})

test('the hit says what to try, that a miss is an error, and which rule matched', () => {
  const mapper = createViteAliasMapper({ aliases: [{ find: 'vue', replacement: 'vue/dist/x.js' }] })
  assert.deepEqual(mapper.map('vue', context), {
    candidates: ['vue/dist/x.js'],
    onMiss: 'error',
    rule: 'vue',
    declared: ['vue/dist/x.js'],
  })
})

test('the factory reads JSON options and refuses a wrong shape', () => {
  const mapper = viteAliasMapper({ aliases: [{ find: 'a', replacement: 'b' }] })
  assert.equal(candidate(mapper, 'a/c'), 'b/c')
  assert.throws(() => viteAliasMapper({ aliases: 'nope' }), { code: 'RESOLVER_BAD_MAPPER' })
  assert.throws(() => viteAliasMapper({ aliases: [{ find: 1, replacement: 'x' }] }), {
    code: 'RESOLVER_BAD_MAPPER',
  })
  assert.throws(
    () => viteAliasMapper({ aliases: [{ find: { source: '(', flags: '' }, replacement: 'x' }] }),
    { code: 'RESOLVER_BAD_MAPPER' },
  )
})
