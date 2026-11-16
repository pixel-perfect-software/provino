// The records' answers that need no registry: the `require-esm` error a failed native load becomes
// (jest-runtime's `CjsLoader` L171-L180), each of its conditions on its own, and the transform
// claims' regular expressions, checked when the loader is made. End to end (the text Jest 30.5.2
// printed) is `provino`'s `transform-node-modules.test.ts`.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { neutralPolicy } from '@provino/policy'
import { createResolver } from '@provino/resolver'
import { createPipeline } from '@provino/transform'
import type { LoaderOptions, ModulePolicy, TransformClaims } from '@provino/types'
import { LoaderError, RequireEsmError } from '../errors.ts'
import type { RuntimeCapabilities } from './edge-kind.ts'
import { createRecords, requireEsmError } from './records.ts'
import { writeTree } from './test-support.ts'

const TEXT = 'Must use import to load ES Module: {path}'
/** Node 22, and 24 before 24.9, under `--experimental-vm-modules`: no synchronous ES module graph. */
const NO_SYNC_EVALUATE: RuntimeCapabilities = { vmModules: true, syncEvaluate: false }
/** Node 24.9 and later under the flag: jest-runtime's `supportsSyncEvaluate`. */
const SYNC_EVALUATE: RuntimeCapabilities = { vmModules: true, syncEvaluate: true }

function optionsFor(
  root: string,
  extra: { readonly policy?: Partial<ModulePolicy>; readonly claims?: TransformClaims } = {},
): LoaderOptions {
  return {
    root,
    engine: 'runner',
    resolver: createResolver({ root, mappers: [], extensions: ['.js'], tsconfig: false }),
    transformer: createPipeline({
      root,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
    }),
    policy: {
      ...neutralPolicy.module,
      messages: { 'require-esm': TEXT },
      ...extra.policy,
    },
    ...(extra.claims === undefined ? {} : { transformClaims: extra.claims }),
  }
}

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
  // `hasEsmSyntax` is false there.
  'node_modules/broken/package.json': JSON.stringify({ name: 'broken' }),
  'node_modules/broken/index.js': "import { a } from './a'\n}\n",
  'src/esm.js': "import { a } from './a'\nexport const b = a\n",
}

const nodeError = Object.assign(new Error("Cannot find module './a'"), {
  code: 'ERR_MODULE_NOT_FOUND',
})

test("require-esm: an ES module Node could not load is Jest's error, with Node's as its cause", () => {
  const root = writeTree(PACKAGES)
  const records = createRecords(optionsFor(root), NO_SYNC_EVALUATE)
  for (const file of ['node_modules/esm/index.js', 'node_modules/esm/other.mjs']) {
    const path = join(root, file)
    const error = requireEsmError(records, path, nodeError)
    assert.ok(error instanceof RequireEsmError, file)
    assert.equal(error.message, `Must use import to load ES Module: ${path}`)
    assert.equal(error.name, 'Error')
    assert.equal(error.code, 'ERR_REQUIRE_ESM')
    assert.equal(error.cause, nodeError, "Node's error is the cause")
  }
  // Jest's own `SyntaxError` is its CommonJS compile of the file, which every ES module fails; Node
  // loads one as an ES module, so any error of that load stands for it (the extensionless import
  // above is `ERR_MODULE_NOT_FOUND`, `cli/transform-node-modules-ignored`), a `SyntaxError` too.
  const syntax = new SyntaxError('Unexpected token')
  const path = join(root, 'node_modules/esm/index.js')
  assert.equal(requireEsmError(records, path, syntax)?.cause, syntax)
})

test('require-esm: Node that evaluates an ES module graph synchronously keeps its own error', () => {
  const root = writeTree(PACKAGES)
  const records = createRecords(optionsFor(root), SYNC_EVALUATE)
  assert.equal(
    requireEsmError(records, join(root, 'node_modules/esm/index.js'), nodeError),
    undefined,
    'supportsSyncEvaluate: Jest loads it as an ES module, and never says require-esm',
  )
})

test('require-esm: a file explicitly CommonJS (`.cjs`, or `.js` under `type: commonjs`) keeps its own error', () => {
  const root = writeTree(PACKAGES)
  const records = createRecords(optionsFor(root), NO_SYNC_EVALUATE)
  for (const file of ['node_modules/explicit/index.js', 'node_modules/esm/plain.cjs']) {
    assert.equal(requireEsmError(records, join(root, file), nodeError), undefined, file)
  }
})

test('require-esm: a file with no ES module syntax, or one the lexer rejects, keeps its own error', () => {
  const root = writeTree(PACKAGES)
  const records = createRecords(optionsFor(root), NO_SYNC_EVALUATE)
  for (const file of ['node_modules/cjs/index.js', 'node_modules/broken/index.js']) {
    assert.equal(requireEsmError(records, join(root, file), nodeError), undefined, file)
  }
})

test('require-esm: no text in the policy, or a file outside node_modules, keeps the error', () => {
  const root = writeTree(PACKAGES)
  const neutral = createRecords(
    optionsFor(root, { policy: { messages: neutralPolicy.module.messages } }),
    NO_SYNC_EVALUATE,
  )
  assert.equal(
    requireEsmError(neutral, join(root, 'node_modules/esm/index.js'), nodeError),
    undefined,
  )
  const records = createRecords(optionsFor(root), NO_SYNC_EVALUATE)
  assert.equal(requireEsmError(records, join(root, 'src/esm.js'), nodeError), undefined)
})

test('transform claims: a pattern, or the ignore patterns joined with |, that is no regular expression is refused', () => {
  const root = writeTree({})
  const refused = (claims: TransformClaims, what: RegExp): void => {
    assert.throws(
      () => createRecords(optionsFor(root, { claims })),
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
  // Jest's default ignores every package: the claims are off, and still checked.
  refused(
    { patterns: ['\\.js$'], ignorePatterns: ['/node_modules/', '\\k<b>', '(?<a>x)'] },
    /joined/,
  )
  assert.equal(
    createRecords(
      optionsFor(root, {
        claims: {
          patterns: ['\\.[jt]sx?$'],
          ignorePatterns: ['/node_modules/', '\\.pnp\\.[^\\/]+$'],
        },
      }),
    ).claims,
    null,
    "Jest's default patterns take no node_modules file: no claims to ask",
  )
})
