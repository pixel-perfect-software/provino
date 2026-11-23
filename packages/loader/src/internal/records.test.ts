// The records' answers that need no registry: the `require-esm` error a failed native load becomes
// (jest-runtime's `CjsLoader` L171-L180), each of its conditions on its own, and the transform
// claims' regular expressions, checked when the loader is made. End to end (the text Jest 30.5.2
// printed) is `provino`'s `transform-node-modules.test.ts`.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { neutralPolicy } from '@provino/policy'
import type { TransformClaims } from '@provino/types'
import { beforeAll, test } from 'provino'
import { LoaderError, RequireEsmError } from '../errors.ts'
import type { RuntimeCapabilities } from './edge-kind.ts'
import { createRecords, type Records } from './records.ts'
import { requireEsmError } from './require-esm.ts'
import { loaderOptionsFor, writeTree } from './test-support.ts'

const TEXT = 'Must use import to load ES Module: {path}'
/** Node 22, and 24 before 24.9, under `--experimental-vm-modules`: no synchronous ES module graph. */
const NO_SYNC_EVALUATE: RuntimeCapabilities = { vmModules: true, syncEvaluate: false }
/** Node 24.9 and later under the flag: jest-runtime's `supportsSyncEvaluate`. */
const SYNC_EVALUATE: RuntimeCapabilities = { vmModules: true, syncEvaluate: true }

const PACKAGES = {
  // No `type`: Node's detection, and Jest's lexer, read the source.
  'node_modules/esm/package.json': JSON.stringify({ name: 'esm' }),
  'node_modules/esm/index.js': "import { a } from './a'\nexport const b = a\n",
  'node_modules/esm/a.js': 'export const a = 1\n',
  'node_modules/esm/other.mjs': 'export const c = 1\n',
  'node_modules/esm/plain.cjs': "import { a } from './a'\nexport const b = a\n",
  'node_modules/explicit/package.json': JSON.stringify({ name: 'explicit', type: 'commonjs' }),
  'node_modules/explicit/index.js': "import { a } from './a'\nexport const b = a\n",
  'node_modules/cjs/package.json': JSON.stringify({ name: 'cjs' }),
  'node_modules/cjs/index.js': "module.exports = require('./missing')\n",
  // ES module words, and a brace es-module-lexer can't match: jest-runtime's lexer throws, and
  // `esmSyntaxOf` is `null` there.
  'node_modules/broken/package.json': JSON.stringify({ name: 'broken' }),
  'node_modules/broken/index.js': "import { a } from './a'\n}\n",
  // Not source text, whatever the bytes say: an addon and a data file are never read as source.
  'node_modules/binary/package.json': JSON.stringify({ name: 'binary' }),
  'node_modules/binary/addon.node': "import { a } from './a'\nexport const b = a\n",
  'node_modules/binary/data.json': "import { a } from './a'\nexport const b = a\n",
  'src/esm.js': "import { a } from './a'\nexport const b = a\n",
}

// Written and built in `beforeAll`, which a listing of the file (every test skipped) never runs.
let root: string
let records: Records
beforeAll(() => {
  root = writeTree(PACKAGES)
  records = createRecords(
    loaderOptionsFor(root, { policy: { messages: { 'require-esm': TEXT } } }),
    NO_SYNC_EVALUATE,
  )
})

const nodeError = Object.assign(new Error("Cannot find module './a'"), {
  code: 'ERR_MODULE_NOT_FOUND',
})

function esmError(from: Records, file: string, error: unknown = nodeError) {
  return requireEsmError(from.options, from.edgeKinds, join(root, file), error)
}

test("require-esm: an ES module Node could not load is Jest's error, with Node's as its cause", () => {
  for (const file of ['node_modules/esm/index.js', 'node_modules/esm/other.mjs']) {
    const error = esmError(records, file)
    assert.ok(error instanceof RequireEsmError, file)
    assert.equal(error.message, `Must use import to load ES Module: ${join(root, file)}`)
    assert.equal(error.name, 'Error')
    assert.equal(error.code, 'ERR_REQUIRE_ESM')
    assert.equal(error.cause, nodeError, "Node's error is the cause")
  }
  // Jest's own `SyntaxError` is its CommonJS compile of the file, which every ES module fails; Node
  // loads one as an ES module, so any error of that load stands for it (the extensionless import
  // above is `ERR_MODULE_NOT_FOUND`, `cli/transform-node-modules-ignored`), a `SyntaxError` too.
  const syntax = new SyntaxError('Unexpected token')
  assert.equal(esmError(records, 'node_modules/esm/index.js', syntax)?.cause, syntax)
})

test('require-esm: Node that evaluates an ES module graph synchronously keeps its own error', () => {
  const sync = createRecords(
    loaderOptionsFor(root, { policy: { messages: { 'require-esm': TEXT } } }),
    SYNC_EVALUATE,
  )
  assert.equal(
    esmError(sync, 'node_modules/esm/index.js'),
    undefined,
    'supportsSyncEvaluate: Jest loads it as an ES module, and never says require-esm',
  )
})

test('require-esm: a file explicitly CommonJS (`.cjs`, or `.js` under `type: commonjs`) keeps its own error', () => {
  for (const file of ['node_modules/explicit/index.js', 'node_modules/esm/plain.cjs']) {
    assert.equal(esmError(records, file), undefined, file)
  }
})

test('require-esm: a file with no ES module syntax, or one the lexer rejects, keeps its own error', () => {
  for (const file of ['node_modules/cjs/index.js', 'node_modules/broken/index.js']) {
    assert.equal(esmError(records, file), undefined, file)
  }
})

test('require-esm: an addon, a WebAssembly module or a JSON file is never read as source', () => {
  for (const file of ['node_modules/binary/addon.node', 'node_modules/binary/data.json']) {
    assert.equal(esmError(records, file), undefined, file)
  }
})

test('require-esm: no text in the policy, or a file outside node_modules, keeps the error', () => {
  const neutral = createRecords(
    loaderOptionsFor(root, { policy: { messages: neutralPolicy.module.messages } }),
    NO_SYNC_EVALUATE,
  )
  assert.equal(esmError(neutral, 'node_modules/esm/index.js'), undefined)
  assert.equal(esmError(records, 'src/esm.js'), undefined)
})

test('transform claims: a pattern, or the ignore patterns joined with |, that is no regular expression is refused', () => {
  const refused = (claims: TransformClaims, what: RegExp): void => {
    assert.throws(
      () => createRecords(loaderOptionsFor(root, { transformClaims: claims })),
      (error: unknown) => {
        assert.ok(error instanceof LoaderError)
        assert.equal(error.code, 'LOADER_INVALID_TRANSFORM_CLAIMS')
        assert.match(error.message, what)
        return true
      },
    )
  }
  refused({ patterns: ['['], ignorePatterns: [] }, /transformClaims\.patterns\[0\]/)
  refused({ patterns: ['\\.js$'], ignorePatterns: ['('] }, /ignorePatterns \(joined with "\|"\)/)
  // Each compiles alone; joined, `\k<b>` is a reference to a group the second one's names lack.
  refused(
    { patterns: ['\\.js$'], ignorePatterns: ['\\k<b>', '(?<a>x)'] },
    /ignorePatterns \(joined with "\|"\)/,
  )
})
