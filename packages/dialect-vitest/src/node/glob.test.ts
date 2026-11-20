// B25c: the two glob helpers, and the alias rules against the replace Vite's alias plugin runs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandGlobs, globToRegexSource } from './glob.ts'
import { writeTree } from './test-support.ts'
import { viteAliasesToNeutral } from './to-neutral.ts'

test('an exclude glob becomes a regular expression over the absolute path', () => {
  const root = '/work/app'
  const exclude = (glob: string, path: string): boolean =>
    new RegExp(globToRegexSource(glob, root)).test(path)
  assert.equal(exclude('**/node_modules/**', '/work/app/node_modules/x/y.test.ts'), true)
  assert.equal(exclude('**/node_modules/**', '/work/app/a/node_modules/x.js'), true)
  assert.equal(exclude('**/node_modules/**', '/work/app/src/x.test.ts'), false)
  assert.equal(exclude('**/.git/**', '/work/app/.git/hooks/x'), true)
  assert.equal(exclude('dist/**', '/work/app/dist/a/b.js'), true)
  assert.equal(exclude('dist/**', '/work/app/src/dist/b.js'), false)
  assert.equal(exclude('**/*.{e2e,perf}.ts', '/work/app/t/a.e2e.ts'), true)
  assert.equal(exclude('**/*.{e2e,perf}.ts', '/work/app/t/a.unit.ts'), false)
  assert.equal(exclude('src/?.ts', '/work/app/src/a.ts'), true)
  assert.equal(exclude('src/?.ts', '/work/app/src/ab.ts'), false)
  assert.equal(exclude('src/*.ts', '/work/app/src/a/b.ts'), false)
})

test('project globs walk the root, skip node_modules, and honour a negation', async () => {
  const root = writeTree({
    'packages/a/x': '',
    'packages/b/x': '',
    'packages/c/nested/x': '',
    'node_modules/pkg/x': '',
    'apps/web/vitest.config.ts': '',
  })
  assert.deepEqual(await expandGlobs(root, ['packages/*']), [
    `${root}/packages/a`,
    `${root}/packages/b`,
    `${root}/packages/c`,
  ])
  assert.deepEqual(await expandGlobs(root, ['packages/*', '!packages/b']), [
    `${root}/packages/a`,
    `${root}/packages/c`,
  ])
  assert.deepEqual(await expandGlobs(root, ['**/vitest.config.ts']), [
    `${root}/apps/web/vitest.config.ts`,
  ])
  assert.deepEqual(await expandGlobs(root, ['**/x']).then((paths) => paths.length), 3)
  assert.deepEqual(await expandGlobs(root, ['missing/*']), [])
})

/** Applies one neutral rule as the name mapper does: the first rule that matches decides. */
function applyRules(
  rules: readonly { pattern: string; targets: readonly string[] }[],
  specifier: string,
): string | null {
  for (const rule of rules) {
    const match = specifier.match(new RegExp(rule.pattern))
    if (match === null) continue
    return (rule.targets[0] as string).replaceAll(
      /\$(\d+)/g,
      (_, i: string) => match[Number(i)] ?? '',
    )
  }
  return null
}

/** What Vite's alias plugin does (@rollup/plugin-alias): matches, then `importee.replace(find, replacement)`. */
function pluginAlias(
  entries: readonly { find: string | RegExp; replacement: string }[],
  specifier: string,
): string | null {
  for (const entry of entries) {
    // Vite trims one trailing slash from both sides when it merges the entries with its own.
    const trim =
      typeof entry.find === 'string' && entry.find.endsWith('/') && entry.replacement.endsWith('/')
    const find = trim ? (entry.find as string).slice(0, -1) : entry.find
    const replacement = trim ? entry.replacement.slice(0, -1) : entry.replacement
    const matches =
      find instanceof RegExp
        ? new RegExp(find.source, find.flags.replace(/g/g, '')).test(specifier)
        : specifier === find || specifier.startsWith(`${find}/`)
    if (matches) return specifier.replace(find, replacement)
  }
  return null
}

test('the neutral alias rules give what the alias plugin gives', () => {
  const entries: { find: string | RegExp; replacement: string }[] = [
    { find: '@', replacement: '/p/src' },
    { find: 'lib/', replacement: '/p/libs/' },
    { find: /^~(.*)$/, replacement: '/p/home$1' },
    { find: /^@old\/(.+)\/index$/, replacement: '/p/new/$1' },
    { find: /vue$/, replacement: 'vue/dist/vue.esm.js' },
    { find: /(a)(b)/, replacement: 'x-$2$1' },
  ]
  const diagnostics: never[] = []
  const rules = viteAliasesToNeutral(entries, diagnostics, 'resolve.alias')
  assert.equal(rules.length, entries.length)
  for (const specifier of [
    '@',
    '@/a/b',
    '@scope/pkg',
    'lib',
    'lib/x',
    '~/q/r',
    '@old/mod/index',
    '@old/mod/other',
    'vue',
    'x/vue',
    'zabq',
    'plain',
  ]) {
    assert.equal(applyRules(rules, specifier), pluginAlias(entries, specifier), specifier)
  }
})

test('an alias object keeps its order, and one that cannot be mapped warns', () => {
  const diagnostics: { code: string }[] = []
  const rules = viteAliasesToNeutral(
    { '@a': '/x', '@b': '/y' },
    diagnostics as never,
    'resolve.alias',
  )
  assert.deepEqual(
    rules.map((rule) => rule.targets[0]),
    ['/x$1', '/y$1'],
  )
  const warned: { code: string }[] = []
  viteAliasesToNeutral([{ find: 'a', replacement: '$&' }], warned as never, 'resolve.alias')
  viteAliasesToNeutral([{ find: /a/i, replacement: 'b' }], warned as never, 'resolve.alias')
  assert.deepEqual(
    warned.map((entry) => entry.code),
    ['VITEST_CONFIG_NOT_APPLIED', 'VITEST_CONFIG_NOT_APPLIED'],
  )
})

test('a negated class, a brace with a slash in it, and dot entries follow tinyglobby with dot: true', async () => {
  const root = writeTree({
    'packages/a/x': '',
    'packages/b/x': '',
    'packages/c/x': '',
    'apps/web/x': '',
    'libs/x': '',
    '.hidden/x': '',
    '.git/x': '',
    '.DS_Store': '',
    'vitest.config.ts.timestamp-1-abc.mjs': '',
    'node_modules/pkg/x': '',
  })
  // [!ab] is "not a or b", as in a shell, not "!, a or b".
  assert.deepEqual(await expandGlobs(root, ['packages/[!ab]']), [`${root}/packages/c`])
  // A brace is expanded before the pattern is cut at its slashes.
  assert.deepEqual(await expandGlobs(root, ['{apps/web,libs}/x']), [
    `${root}/apps/web/x`,
    `${root}/libs/x`,
  ])
  // dot: true: * and ** match dot entries and descend into dot directories; node_modules, a
  // .DS_Store and a *.timestamp-* bundle are what Vitest ignores.
  assert.deepEqual(await expandGlobs(root, ['*/x']), [
    `${root}/.git/x`,
    `${root}/.hidden/x`,
    `${root}/libs/x`,
  ])
  const all = await expandGlobs(root, ['**/x'])
  assert.ok(all.includes(`${root}/.git/x`) && all.includes(`${root}/.hidden/x`))
  assert.ok(!all.some((path) => path.includes('node_modules')))
  assert.deepEqual(
    await expandGlobs(root, ['*']).then((paths) =>
      paths.filter((path) => /DS_Store|timestamp/.test(path)),
    ),
    [],
  )
})

test('the same cuts and classes in an exclude regular expression', () => {
  const regex = (glob: string) => new RegExp(globToRegexSource(glob, '/work/app'))
  assert.equal(regex('{apps/web,libs}/**').test('/work/app/apps/web/a.ts'), true)
  assert.equal(regex('{apps/web,libs}/**').test('/work/app/libs/a.ts'), true)
  assert.equal(regex('{apps/web,libs}/**').test('/work/app/apps/api/a.ts'), false)
  assert.equal(regex('src/[!a]*.ts').test('/work/app/src/b.ts'), true)
  assert.equal(regex('src/[!a]*.ts').test('/work/app/src/a.ts'), false)
})
