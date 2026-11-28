// A native project evaluates again, in each later file of a worker, the `node_modules` packages
// whose first load read a file's window or wrote a global (#233): `@testing-library/dom` builds
// `screen` over `document.body` as it loads, and a package that adds a key to the global as it
// loads has it taken away by the environment's restore after the first file. Through the source bin.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'provino'
import {
  linkDevDependencies,
  NATIVE_JSDOM_CONFIG,
  nativeProject,
  POOLS,
  runFiles,
} from './support.ts'

/** A file that renders a paragraph with React Testing Library and finds it through `screen`. */
function findsThroughScreen(word: string): string {
  return [
    "import { render, screen, within } from '@testing-library/react'",
    "import { expect, it } from 'provino'",
    "import { createElement } from 'react'",
    `it('finds what it rendered through screen (file ${word})', () => {`,
    `  render(createElement('p', null, 'hello ${word}'))`,
    `  expect(within(document.body).getByText('hello ${word}')).toBeTruthy()`,
    `  expect(screen.getByText('hello ${word}')).toBeTruthy()`,
    '})',
    '',
  ].join('\n')
}

/** The packages the project imports, from this package's devDependencies. */
const TESTING_LIBRARY = ['react', 'react-dom', '@testing-library/react', '@testing-library/dom']

/** The node_modules files the first run learned to evaluate per file, from the results cache. */
function learnedExternals(dir: string): string[] {
  const file = join(dir, 'node_modules', '.cache', 'provino', 'results.json')
  const data = JSON.parse(readFileSync(file, 'utf8')) as {
    externals?: Record<string, Record<string, string>>
  }
  return Object.values(data.externals ?? {}).flatMap((entries) => Object.keys(entries))
}

describe('packages a native worker shares between files', () => {
  for (const pool of POOLS) {
    test(`screen of Testing Library searches the second file's own document, on the ${pool} pool`, async () => {
      const dir = await nativeProject(
        { 'tests/a.test.ts': findsThroughScreen('a'), 'tests/b.test.ts': findsThroughScreen('b') },
        NATIVE_JSDOM_CONFIG,
      )
      linkDevDependencies(dir, TESTING_LIBRARY)
      expect(await runFiles(dir, pool, ['a', 'b'])).toEqual({
        code: 0,
        outcomes: { a: 'passed', b: 'passed' },
      })
    })
  }

  test('screen still finds the rendered text on a second run, which starts from what the first learned', async () => {
    const dir = await nativeProject(
      { 'tests/a.test.ts': findsThroughScreen('a'), 'tests/b.test.ts': findsThroughScreen('b') },
      NATIVE_JSDOM_CONFIG,
    )
    linkDevDependencies(dir, TESTING_LIBRARY)
    const expected = { code: 0, outcomes: { a: 'passed', b: 'passed' } }
    expect(await runFiles(dir, 'forks', ['a', 'b'])).toEqual(expected)
    expect(learnedExternals(dir).some((path) => path.includes('@testing-library/dom'))).toBe(true)
    expect(await runFiles(dir, 'forks', ['a', 'b'])).toEqual(expected)
  })

  test('a package that adds a key to the global as it loads has it again in the next file, on the node environment', async () => {
    const dir = await nativeProject({
      'node_modules/global-writer/package.json':
        '{"name":"global-writer","version":"1.0.0","main":"index.js"}\n',
      'node_modules/global-writer/index.js': [
        'globalThis.__globalWriter ??= { loadedFor: 0 }',
        'globalThis.__globalWriter.loadedFor++',
        'exports.read = () => globalThis.__globalWriter',
        '',
      ].join('\n'),
      'tests/a.test.ts': readsWritten(),
      'tests/b.test.ts': readsWritten(),
    })
    expect(await runFiles(dir, 'forks', ['a', 'b'])).toEqual({
      code: 0,
      outcomes: { a: 'passed', b: 'passed' },
    })
  })
})

/** A file that reads the key `global-writer` adds as it loads. */
function readsWritten(): string {
  return [
    "import { expect, it } from 'provino'",
    "import { read } from 'global-writer'",
    "it('sees the key the package added to the global', () => {",
    '  expect(read()).toEqual({ loadedFor: 1 })',
    '})',
    '',
  ].join('\n')
}
