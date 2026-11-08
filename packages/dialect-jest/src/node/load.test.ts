// T11.4's checks: each format loads to what real `jest-config` 30.5.2 reads
// (`readInitialOptions(path)`): `.ts`/`.mts`/`.cts` through Node's type stripping with no ts-node,
// function exports awaited, JSON with comments, `package.json`'s `jest` key, `rootDir` defaulted to
// the file's directory or resolved against it. A `@jest-config-loader` docblock is honoured; a
// TypeScript file Node can't strip, with no docblock, fails saying what to do.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { JestConfigError } from './errors.ts'
import {
  comparable,
  loadOracle,
  type Oracle,
  removeTree,
  type Tree,
  writeTree,
} from './internal/test-support.ts'
import { loadJestConfig, readJestConfigFile, stripJsonComments } from './load.ts'

let oracle: Oracle
const trees: string[] = []

before(async () => {
  oracle = await loadOracle()
})

after(() => {
  for (const tree of trees) removeTree(tree)
})

function tree(files: Tree): string {
  const root = writeTree(files)
  trees.push(root)
  return root
}

async function oracleRead(path: string): Promise<unknown> {
  const read = (await oracle.readInitialOptions(path)) as { config: unknown }
  return read.config
}

interface Case {
  readonly name: string
  readonly tree: Tree
  readonly file: string
}

const CASES: readonly Case[] = [
  {
    name: 'CommonJS object (.js)',
    tree: { 'jest.config.js': "module.exports = { testTimeout: 1, roots: ['<rootDir>/src'] }\n" },
    file: 'jest.config.js',
  },
  {
    name: 'ESM default export (.mjs)',
    tree: { 'jest.config.mjs': "export default { testEnvironment: 'node' }\n" },
    file: 'jest.config.mjs',
  },
  {
    name: '.ts through type stripping',
    tree: {
      'jest.config.ts':
        "import type { Config } from 'jest'\nconst config: Config = { testTimeout: 2 as number }\nexport default config\n",
    },
    file: 'jest.config.ts',
  },
  {
    name: '.mts through type stripping',
    tree: {
      'jest.config.mts': 'const timeout: number = 3\nexport default { testTimeout: timeout }\n',
    },
    file: 'jest.config.mts',
  },
  {
    name: '.cts through type stripping',
    tree: {
      'jest.config.cts': 'const timeout: number = 4\nmodule.exports = { testTimeout: timeout }\n',
    },
    file: 'jest.config.cts',
  },
  {
    name: '.cjs function export, awaited',
    tree: { 'jest.config.cjs': 'module.exports = () => ({ verbose: true })\n' },
    file: 'jest.config.cjs',
  },
  {
    name: '.ts async function export, awaited',
    tree: {
      'jest.config.ts':
        'export default async (): Promise<object> => ({ bail: 1, testTimeout: await Promise.resolve(5) })\n',
    },
    file: 'jest.config.ts',
  },
  {
    name: 'compiled `export default` (CommonJS with __esModule)',
    tree: {
      'jest.config.js':
        'Object.defineProperty(exports, "__esModule", { value: true });\nexports.default = { clearMocks: true };\n',
    },
    file: 'jest.config.js',
  },
  {
    // streamich/react-use's jest.config.base.ts in the sample: required, so its namespace is the config.
    name: '.ts with only named exports: the namespace is the config',
    tree: {
      'jest.config.ts':
        "export const base: { testTimeout: number } = { testTimeout: 3 }\nexport const other = 'x'\n",
    },
    file: 'jest.config.ts',
  },
  {
    name: 'ESM .js with only named exports (type: module)',
    tree: {
      'package.json': '{ "type": "module" }\n',
      'jest.config.js': 'export const verbose = true\n',
    },
    file: 'jest.config.js',
  },
  {
    name: 'JSON with comments',
    tree: {
      'jest.config.json':
        '{\n  // a line comment\n  "testRegex": "//not-a-comment",\n  /* a block\n comment */ "verbose": true\n}\n',
    },
    file: 'jest.config.json',
  },
  {
    name: "package.json's jest key",
    tree: { 'package.json': '{ "name": "a", "jest": { "testTimeout": 6 } }\n' },
    file: 'package.json',
  },
  {
    name: 'package.json without a jest key reads as {}',
    tree: { 'package.json': '{ "name": "a" }\n' },
    file: 'package.json',
  },
  {
    name: 'a relative rootDir resolves against the file',
    tree: {
      'config/jest.config.js': "module.exports = { rootDir: '..', testTimeout: 7 }\n",
    },
    file: 'config/jest.config.js',
  },
  {
    name: 'an absolute rootDir is kept',
    tree: { 'jest.config.js': "module.exports = { rootDir: '/somewhere/else' }\n" },
    file: 'jest.config.js',
  },
]

for (const fixture of CASES) {
  test(`loads what jest-config loads: ${fixture.name}`, async () => {
    const root = tree(fixture.tree)
    const path = join(root, fixture.file)
    const ours = await readJestConfigFile(path)
    const theirs = await oracleRead(path)
    assert.deepEqual(comparable(ours), comparable(theirs))
  })
}

test('TypeScript loads natively: no ts-node is installed', async () => {
  const root = tree({ 'jest.config.ts': 'export default { testTimeout: 8 as number }\n' })
  assert.throws(() => createRequire(join(root, 'x.js')).resolve('ts-node'))
  assert.equal((await readJestConfigFile(join(root, 'jest.config.ts'))).testTimeout, 8)
})

test('rootDir defaults to the file directory', async () => {
  const root = tree({ 'nested/jest.config.js': 'module.exports = {}\n' })
  assert.equal(
    (await readJestConfigFile(join(root, 'nested/jest.config.js'))).rootDir,
    join(root, 'nested'),
  )
})

test('inline JSON takes the directory as rootDir', async () => {
  const loaded = await loadJestConfig({ kind: 'inline', path: '/repo', text: '{"testTimeout":9}' })
  assert.deepEqual(loaded, { options: { testTimeout: 9, rootDir: '/repo' }, configPath: null })
  const read = (await oracle.readInitialOptions('{"testTimeout":9}', {
    packageRootOrConfig: '/repo',
  })) as { config: unknown }
  assert.deepEqual(loaded.options, read.config)
})

// A loader the docblock names, standing in for esbuild-register: it compiles `.ts` files by
// turning an enum (which Node can't strip) into an object.
const FAKE_ESBUILD_REGISTER = `const Module = require('node:module')
const { readFileSync } = require('node:fs')
exports.register = () => {
  const previous = Module._extensions['.ts']
  Module._extensions['.ts'] = (module, filename) => {
    const source = readFileSync(filename, 'utf8').replace(/enum (\\w+) \\{[^}]*\\}/, 'const $1 = { A: 0 }')
    module._compile(source, filename)
  }
  return { unregister() { Module._extensions['.ts'] = previous } }
}
`

test('a @jest-config-loader docblock is honoured when Node cannot strip the file', async () => {
  const root = tree({
    'node_modules/esbuild-register/package.json': '{ "name": "esbuild-register" }\n',
    'node_modules/esbuild-register/dist/node.js': FAKE_ESBUILD_REGISTER,
    'jest.config.ts':
      '/** @jest-config-loader esbuild-register */\nenum Mode { A }\nmodule.exports = { testTimeout: 10 + Mode.A }\n',
  })
  const loaded = await readJestConfigFile(join(root, 'jest.config.ts'))
  assert.equal(loaded.testTimeout, 10)
})

test('a TypeScript file Node cannot strip, with no docblock, says what to do', async () => {
  const root = tree({
    'jest.config.ts': 'enum Mode { A }\nmodule.exports = { testTimeout: Mode.A }\n',
  })
  await assert.rejects(readJestConfigFile(join(root, 'jest.config.ts')), (error: unknown) => {
    assert.ok(error instanceof JestConfigError)
    assert.equal(error.code, 'JEST_CONFIG_TS_LOADER')
    assert.match(error.message, /^Jest: Failed to parse the TypeScript config file /)
    assert.match(error.message, /@jest-config-loader ts-node/)
    return true
  })
  // Real Jest fails here too: it falls back to ts-node, which isn't installed.
  await assert.rejects(oracleRead(join(root, 'jest.config.ts')), /ts-node/)
})

test('stripJsonComments keeps strings and positions', () => {
  const text = '{"a": "// x", /* c */ "b": 1} // end'
  const stripped = stripJsonComments(text)
  assert.equal(stripped.length, text.length)
  assert.deepEqual(JSON.parse(stripped), { a: '// x', b: 1 })
  assert.deepEqual(JSON.parse(stripJsonComments('{"a": "\\"/* x */"}')), { a: '"/* x */' })
})

test("an .mjs config with no default export fails on both sides, with Jest's text", async () => {
  const root = tree({ 'jest.config.mjs': 'export const verbose = true\n' })
  const path = join(root, 'jest.config.mjs')
  await assert.rejects(readJestConfigFile(path), (error: unknown) => {
    assert.ok(error instanceof JestConfigError)
    assert.equal(
      error.message,
      `Jest: Failed to load ESM at ${path} - did you use a default export?`,
    )
    return true
  })
  await assert.rejects(oracleRead(path), /did you use a default export\?/)
})

function commentLines(count: number): string {
  return `${'// a comment line\n'.repeat(count)}{ "testTimeout": 1 }\n`
}

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/**
 * The process's CPU time for `run`, in ms: time spent preempted doesn't count, so a busy machine
 * doesn't stretch it. Wall time did: with the machine oversubscribed, a 30 ms run is cut into
 * several slices and a 3 ms one mostly isn't, and the ratio below read 9 to 13 on linear code.
 */
function cpuMs(run: () => void): number {
  const start = process.cpuUsage()
  run()
  const used = process.cpuUsage(start)
  return (used.user + used.system) / 1000
}

// This checks how the cost grows, not how long it takes, so a slow or busy runner doesn't fail it:
// both sizes run on the same machine, interleaved, in CPU time, and the median of each is compared.
// Each small sample times four runs in a row (and counts a quarter), so both windows are about as
// long and see the same GC. Four times the comment lines should cost about four times as much
// (about 4.5 measured); a pass that copies the rest of the text for every comment costs about
// sixteen times as much. The bar sits between.
test('stripJsonComments grows linearly: 4x the comment lines cost well under 16x the time', () => {
  const small = commentLines(10_000)
  const large = commentLines(40_000)
  for (const text of [small, large]) {
    assert.deepEqual(JSON.parse(stripJsonComments(text)), { testTimeout: 1 })
  }
  for (let warmup = 0; warmup < 3; warmup++) {
    stripJsonComments(small)
    stripJsonComments(large)
  }
  const smallMs: number[] = []
  const largeMs: number[] = []
  for (let run = 0; run < 7; run++) {
    smallMs.push(
      cpuMs(() => {
        for (let repeat = 0; repeat < 4; repeat++) stripJsonComments(small)
      }) / 4,
    )
    largeMs.push(cpuMs(() => stripJsonComments(large)))
  }
  const ratio = median(largeMs) / median(smallMs)
  assert.ok(
    ratio < 8,
    `4x the input took ${ratio.toFixed(1)}x the time (${median(smallMs).toFixed(1)} ms, then ${median(largeMs).toFixed(1)} ms); linear is about 4, quadratic about 16`,
  )
})

test('an unclosed block comment that breaks the JSON says so, where it starts', async () => {
  const root = tree({
    'jest.config.json': '{\n  "testTimeout": 1, /* never closed\n  "verbose": true\n}\n',
  })
  const path = join(root, 'jest.config.json')
  await assert.rejects(readJestConfigFile(path), (error: unknown) => {
    assert.ok(error instanceof JestConfigError)
    assert.equal(error.code, 'JEST_CONFIG_LOAD_FAILED')
    // `  "testTimeout": 1, /* never closed`: the `/*` is the 21st character of line 2.
    assert.match(error.message, /unclosed \/\* comment at line 2, column 21 runs to the end/)
    return true
  })
  // Jest's parser fails on it too.
  await assert.rejects(oracleRead(path))
})

test('an unclosed block comment after complete JSON reads, as in Jest', async () => {
  const root = tree({ 'jest.config.json': '{ "testTimeout": 7 } /* trailing, never closed\n' })
  const path = join(root, 'jest.config.json')
  assert.equal((await readJestConfigFile(path)).testTimeout, 7)
  assert.deepEqual(comparable(await readJestConfigFile(path)), comparable(await oracleRead(path)))
})

test('a config that is not an object is refused', async () => {
  const root = tree({ 'jest.config.js': 'module.exports = 5\n' })
  await assert.rejects(readJestConfigFile(join(root, 'jest.config.js')), {
    code: 'JEST_CONFIG_INVALID',
  })
})
