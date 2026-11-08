// The evidence for the `module` slice and the hoisting rules (T1.7). The mod corpus (B13b) runs the
// module-mock registry and the hoister through a fake loader against the `mocking/mod-*` goldens;
// the hoist corpus runs every case through the real `babel-plugin-jest-hoist` and `@vitest/mocker`
// and flips each `HoistPolicy` key itself.
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'
import { fileErrorOf, templateIn } from '../observe.ts'

const mod = (...fixtures: readonly string[]) =>
  corpus('mod', ...fixtures.map((name) => `mocking/${name}`))

const builtByB13c = (what: string) =>
  pending('B13c', `${what}: the shipped loader surfaces it, and its first fixture records the text`)

export const moduleClaims: Claims = {
  'module.factoryShape': mod('mod-factory-shape', 'mod-automock-all', 'mod-automock-cjs'),
  'module.rootMocksAutoApply': mod('mod-root-package', 'mod-root-core'),
  'module.automock': each(
    [mod('mod-adjacent', 'mod-automock-all'), golden('defaults')],
    mod('mod-adjacent'),
  ),
  'module.actual': mod('mod-adjacent', 'mod-partial', 'mod-automock-cjs'),
  'module.resetModulesBetween': each(
    [golden('module-between'), golden('defaults')],
    golden('module-between'),
  ),
  'module.injectCjsGlobals': each(golden('module-between'), [
    golden('module-between'),
    golden('defaults'),
  ]),
  'module.interopDefault': mod('mod-automock-all', 'mod-automock-cjs'),
  'module.resetModulesClearsMocks': mod('mod-do-mock', 'mod-reset-modules'),
  'module.awaitFactory': mod(
    'mod-do-mock',
    'mod-factory-async',
    'mod-factory-async-missing-export',
  ),
  'module.missingFactoryExport': mod(
    'mod-factory-symbol-reads',
    'mod-factory-async-missing-export',
    'mod-factory-shape',
  ),
  'module.requireVirtualFlag': mod('mod-missing', 'mod-virtual'),
  'module.virtualRelative': mod('mod-virtual', 'mod-missing', 'mod-virtual-static'),
  'module.mockValueOwner': mod('mod-reregister', 'mod-reset-modules'),
  'module.automockShape': mod('mod-automock-shape', 'mod-automock-inherited'),
  'module.unmockedPathPatterns': each(
    mod('mod-automock-all', 'mod-unmocked-patterns'),
    inert(
      'module.automock',
      false,
      'only automock-all reads the patterns, and Vitest has no automock-all',
      mod('mod-automock-shape', 'mod-automock-inherited', 'mod-automock-symbol-keys'),
    ),
  ),
  // Jest's texts. The corpus compares a crash's first paragraph; the golden shows the whole text.
  'module.messages.module-missing': [
    mod('mod-missing'),
    golden('mocking/mod-missing', {
      matches: (g, value) => templateIn(value, fileErrorOf(g)),
    }),
  ],
  'module.messages.unmock-module-missing': mod('mod-unmock-missing'),
  'module.messages.automock-no-metadata': builtByB13c(
    'no mod-* case automocks a value with no metadata',
  ),
  'module.messages.nested-isolation': mod('mod-isolate-modules'),
  // Vitest's texts.
  'module.messages.factory-not-object': mod('mod-factory-function'),
  'module.messages.missing-factory-export': mod('mod-factory-async-missing-export'),
  'module.messages.unresolved-relative-mock': mod('mod-missing', 'mod-virtual'),
  'module.messages.factory-error': mod('mod-factory-reject-retry'),
}

const hoist = corpus('hoist')

/** Fixtures that run each dialect's hoister through the fake loader: an inert rule's readers. */
const jestHoisting = mod(
  'mod-hoist-order',
  'mod-hoist-require',
  'mod-adjacent',
  'mod-factory-shape',
)
const vitestHoisting = mod(
  'mod-hoist-order',
  'mod-import-this',
  'mod-reexport-order',
  'mod-factory-function',
)

/** No method takes the `path-factory-options` rule, the only one that checks a factory. */
const noFactoryRule = (rules: readonly unknown[]): boolean =>
  rules.length > 0 && rules.every((rule) => rule !== 'path-factory-options')

export const hoistClaims: Claims = {
  'hoist.id': each(
    own(
      'packages/dialect-jest/src/hoist-policy.test.ts',
      'jest-30.5',
      'jest-30.5',
      'names the rules for the transform cache; nothing else reads it',
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'vitest-5.0',
      'vitest-5.0',
      'names the rules for the transform cache; nothing else reads it',
    ),
  ),
  'hoist.objects': hoist,
  'hoist.hoistCalls': hoist,
  'hoist.hoistValues': hoist,
  'hoist.rewriteImportArg': hoist,
  'hoist.chainable': each(
    hoist,
    inert(
      'hoist.placement',
      'top-level-only',
      'only enclosing-block placement reads it',
      vitestHoisting,
    ),
  ),
  'hoist.placement': hoist,
  'hoist.topLevelGuards': each(
    inert(
      'hoist.placement',
      'enclosing-block',
      'only top-level-only placement reads it',
      jestHoisting,
    ),
    hoist,
  ),
  'hoist.factoryReferences': each(
    hoist,
    inert(
      'hoist.hoistCalls',
      noFactoryRule,
      'only a path-factory-options argument rule reads it, and no Vitest method has one',
      vitestHoisting,
    ),
  ),
  'hoist.runnerModules': hoist,
  'hoist.reExports': hoist,
  'hoist.rewrittenCalls': hoist,
  // Jest's plugin raises the first two; under enclosing-block placement the engine can't raise
  // the other four, whose text only says so.
  'hoist.messages.HOIST_FACTORY_OUT_OF_SCOPE': each(
    builtByB13c(
      "the golden drops the Allowed objects line (it follows Node's globals), so only the loader's own run can show the whole text",
    ),
    inert(
      'hoist.hoistCalls',
      noFactoryRule,
      'no Vitest method has a factory rule, so it never checks what a factory reads',
      vitestHoisting,
    ),
  ),
  'hoist.messages.HOIST_FACTORY_NOT_FUNCTION': each(
    builtByB13c('no mod-* case passes jest.mock a factory that is not a function'),
    inert(
      'hoist.hoistCalls',
      noFactoryRule,
      'no Vitest method has a factory rule, so it never checks a factory argument',
      vitestHoisting,
    ),
  ),
  'hoist.messages.HOIST_NOT_TOP_LEVEL': each(
    inert(
      'hoist.placement',
      'enclosing-block',
      'Jest hoists within the block, so the engine never raises it',
      jestHoisting,
    ),
    builtByB13c('no mod-* case calls vi.mock below the top level'),
  ),
  'hoist.messages.HOIST_NESTED': each(
    inert(
      'hoist.placement',
      'enclosing-block',
      'Jest allows a hoisted call inside another',
      jestHoisting,
    ),
    builtByB13c('no mod-* case nests vi.mock'),
  ),
  'hoist.messages.HOIST_EXPORTED': each(
    inert('hoist.placement', 'enclosing-block', 'Jest never looks at exports', jestHoisting),
    builtByB13c('no mod-* case exports vi.mock'),
  ),
  'hoist.messages.HOIST_EXPORTED_VALUE': each(
    inert('hoist.placement', 'enclosing-block', 'Jest has no hoisted values', jestHoisting),
    builtByB13c('no mod-* case exports vi.hoisted'),
  ),
}
