// T9.16: haste's dependency extractor against the real one, in-process (D27). jest-haste-map is a
// dependency of @jest/core, which jest-cli (a devDependency) depends on. Its bundled build exports
// no `extractor`, so the oracle is reached the way haste hands it out: its `worker` calls a custom
// `dependencyExtractor` with the default extractor's `extract` as the fallback, and the one written
// here keeps it.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { jestDependencyExtractor } from './index.ts'

type Extract = (code: string) => Iterable<string>

const core = createRequire(fileURLToPath(import.meta.resolve('jest-cli'))).resolve('@jest/core')
const workerPath = join(createRequire(core).resolve('jest-haste-map'), '..', 'worker.js')
const { worker } = createRequire(core)(workerPath) as {
  worker: (data: Record<string, unknown>) => Promise<unknown>
}

let dir = ''
let real: Extract | undefined

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'provino-haste-'))
  const keeper = join(dir, 'keeper.cjs')
  await writeFile(
    keeper,
    'module.exports = { extract(code, path, fallback) { globalThis.__provinoHasteExtract = fallback; return [] } }\n',
  )
  const file = join(dir, 'file.js')
  await writeFile(file, '\n')
  await worker({
    computeDependencies: true,
    dependencyExtractor: keeper,
    filePath: file,
    rootDir: dir,
  })
  real = (globalThis as { __provinoHasteExtract?: Extract }).__provinoHasteExtract
  assert.equal(typeof real, 'function', 'the worker handed the custom extractor no fallback')
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Sources that cover every regex and the cases around it. */
const SOURCES: readonly string[] = [
  "import a from './a'\nimport { b } from \"./b\"\nimport './side'\n",
  "export * from './star'\nexport { x } from './named'\nexport const y = 1\n",
  "import type { T } from './types'\nimport typeof U from './typeof'\nexport type { V } from './v'\n",
  "import typed from './typed-name'\nimport typeofer from './typeofer'\n",
  'const m = require(\'./m\')\nconst n = require( "./n" , )\nconst o = require(`./o`)\n',
  "const p = import('./p')\nawait import( './q' )\n",
  "obj.require('./not-dep')\nobj . import('./also-not')\n...require('./spread')\n",
  "jest.requireActual('./actual')\njest . requireMock('./mock')\njest.createMockFromModule('./auto')\n",
  "// require('./line-comment')\n/* import x from './block-comment' */\nrequire('./after')\n",
  "/* multi\n line require('./ml') */ const k = require('./kept')\n",
  'const s = \'require("./in-string")\'\n',
  "require(variable)\nrequire('./a' + b)\nrequire('./mixed\")\n",
  "import {\n  a,\n  b,\n} from './multiline'\n",
  'export default function () {}\nexport { local }\n',
  "const url = 'http://example.invalid/x' // require('./after-url')\nrequire('./real')\n",
  "requireX('./no')\nmyrequire('./no2')\n_require('./no3')\n",
  "import('./a', { with: { type: 'json' } })\n",
  'import json from "./data.json" with { type: "json" }\n',
]

test('the extractor reads the specifiers jest-haste-map reads, in its order', () => {
  const ours = jestDependencyExtractor()
  const oracle = real
  assert.ok(oracle !== undefined)
  let found = 0
  for (const source of SOURCES) {
    const expected: string[] = [...oracle(source)]
    found += expected.length
    const got = [...ours.extract(source, '/x.ts', () => [])]
    assert.deepEqual(got, expected, source)
  }
  // The oracle read edges at all, so equal lists can't be two empty ones.
  assert.ok(found > 20)
})

test('the extractor names its version for the edge cache', () => {
  assert.equal(typeof jestDependencyExtractor().cacheKey, 'string')
})
