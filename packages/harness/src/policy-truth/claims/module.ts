// The evidence for the `module` slice and the hoisting rules (T1.7). The mod corpus (B13b, on the
// real loader since B13c) runs the module-mock registry and the hoister through `@provino/loader`
// against the `mocking/mod-*` goldens; the hoist corpus runs every case through the real
// `babel-plugin-jest-hoist` and `@vitest/mocker` and flips each `HoistPolicy` key itself.
import type { Golden } from '../../golden.ts'
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'
import { fileErrorOf, ObservationError, observation, templateIn } from '../observe.ts'

const mod = (...fixtures: readonly string[]) =>
  corpus('mod', ...fixtures.map((name) => `mocking/${name}`))

/** The loader raises it (B13c), but no `mod-*` case does yet: the owner's first fixture records it. */
const noCaseYet = (owner: string, what: string) =>
  pending(owner, `${what}: the loader raises it, and the first fixture that does records the text`)

/** The message of the error an `observe` case recorded: the case's `threw`, or its value. */
function observedMessage(g: Golden, id: string): string {
  const seen = observation(g, id)
  const error = typeof seen === 'object' && seen !== null && 'threw' in seen ? seen.threw : seen
  const message =
    typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : error
  if (typeof message !== 'string') {
    throw new ObservationError(`${g.suite} (${g.runner}) "${id}" recorded no error message`)
  }
  return message
}

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
  'module.mockResolveKind': mod('mod-conditions'),
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
  'module.messages.automock-no-metadata': [
    mod('mod-automock-no-metadata'),
    golden('mocking/mod-automock-no-metadata', {
      matches: (g, value) =>
        templateIn(value, observedMessage(g, 'requiring an automocked module with no metadata')),
    }),
  ],
  // The shipped `jest` refuses a nested isolation with its own copy of this text before the file's
  // module-mock registry is asked, so no mod-* run reaches the registry's (this value); it is
  // reached only when the global `jest` and a module's own nest. The golden records Jest's text.
  'module.messages.nested-isolation': golden('jest-object-returns', {
    matches: (g, value) =>
      templateIn(value, observedMessage(g, 'isolateModules inside isolateModules')),
  }),
  // The loader's texts (B13c Gap 4). A transform error is the crash's cause; the golden's first
  // paragraph is the whole of it, less Babel's `Allowed objects:` line (left out on both sides).
  'module.messages.transform-failed': [
    mod('mod-factory-out-of-scope'),
    golden('mocking/mod-factory-out-of-scope', {
      matches: (g, value) => templateIn(value, fileErrorOf(g)),
    }),
  ],
  'module.messages.module-not-found': [
    mod('mod-root-package-uninstalled'),
    golden('mocking/mod-root-package-uninstalled', {
      matches: (g, value) => templateIn(value, observedMessage(g, 'load after dontMock')),
    }),
  ],
  // jest-resolve's error for a `moduleNameMapper` rule that matched and resolved to nothing, for a
  // single target and for a list (`resolve/mapper-miss`; the placeholders stand for the paths).
  'module.messages.mapper-miss': golden('resolve/mapper-miss', {
    matches: (g, value) =>
      ['single', 'array', 'first'].every((id) => templateIn(value, observedMessage(g, id))),
  }),
  // Vitest's texts.
  'module.messages.factory-not-object': mod('mod-factory-function'),
  'module.messages.missing-factory-export': mod('mod-factory-async-missing-export'),
  'module.messages.unresolved-relative-mock': mod('mod-missing', 'mod-virtual'),
  // The test file's load fails on the unresolved mock (`mod-virtual-static`, a crash); an import
  // inside a test isn't wrapped (`mod-missing`).
  'module.messages.unresolved-mock-import': [
    mod('mod-virtual-static', 'mod-missing'),
    golden('mocking/mod-virtual-static', {
      matches: (g, value) => templateIn(value, fileErrorOf(g)),
    }),
  ],
  'module.messages.factory-error': mod('mod-factory-reject-retry'),
}

const hoist = corpus('hoist')

/** Fixtures that run each dialect's hoister through the real loader: an inert rule's readers. */
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
  // The loader raises it through `transform-failed` (B13c): the corpus compares the crash's cause,
  // less the `Allowed objects:` line, which the golden drops (it follows Node's globals).
  'hoist.messages.HOIST_FACTORY_OUT_OF_SCOPE': each(
    mod('mod-factory-out-of-scope'),
    inert(
      'hoist.hoistCalls',
      noFactoryRule,
      'no Vitest method has a factory rule, so it never checks what a factory reads',
      vitestHoisting,
    ),
  ),
  'hoist.messages.HOIST_FACTORY_NOT_FUNCTION': each(
    [
      mod('mod-factory-not-function'),
      // The plugin's text has a trailing newline the crash message does not keep.
      golden('mocking/mod-factory-not-function', {
        matches: (g, value) => typeof value === 'string' && fileErrorOf(g).includes(value.trim()),
      }),
    ],
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
    noCaseYet('T11.16', 'no mod-* case calls vi.mock below the top level'),
  ),
  'hoist.messages.HOIST_NESTED': each(
    inert(
      'hoist.placement',
      'enclosing-block',
      'Jest allows a hoisted call inside another',
      jestHoisting,
    ),
    noCaseYet('T11.16', 'no mod-* case nests vi.mock'),
  ),
  'hoist.messages.HOIST_EXPORTED': each(
    inert('hoist.placement', 'enclosing-block', 'Jest never looks at exports', jestHoisting),
    noCaseYet('T11.16', 'no mod-* case exports vi.mock'),
  ),
  'hoist.messages.HOIST_EXPORTED_VALUE': each(
    inert('hoist.placement', 'enclosing-block', 'Jest has no hoisted values', jestHoisting),
    noCaseYet('T11.16', 'no mod-* case exports vi.hoisted'),
  ),
}
