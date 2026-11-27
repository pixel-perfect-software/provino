// The evidence for the `module` slice and the hoisting rules (T1.7). The mod corpus (B13b, on the
// real loader since B13c) runs the module-mock registry and the hoister through `@provino/loader`
// against the `mocking/mod-*` goldens; the hoist corpus runs every case through the real
// `babel-plugin-jest-hoist` and `@vitest/mocker` and flips each `HoistPolicy` key itself.
import type { Golden } from '../../golden.ts'
import { type Claims, corpus, each, golden, inert, own, pending } from '../evidence.ts'
import {
  fileErrorOf,
  ObservationError,
  observation,
  observedOf,
  oneOf,
  statusOf,
  templateIn,
  testIn,
  titlesOf,
} from '../observe.ts'

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

/**
 * Whether the golden's later file still had what a package did as it loaded (D127, P42): every
 * test of the file Jest ran second passed. A runner that evaluated the package once per worker
 * fails them (RTL's `screen` and `cleanup` bound to the first file's `document`; a `getContext`
 * mock that is `null`).
 */
const reevaluatedIn =
  (...titles: readonly string[]) =>
  (g: Golden): boolean =>
    titles.every((title) => statusOf(g, title) === 'passed')

/**
 * Reads the value a fixture's tests all show by how their titles end: every test is titled with
 * the entry it got, so the value is the one whose ending every title has (`oneOf` fails on a golden
 * that shows none of them, or several).
 */
const shownByTitleEnding =
  (endings: Readonly<Record<string, string>>) =>
  (g: Golden): string => {
    const titles = titlesOf(g)
    return oneOf(
      titles,
      Object.entries(endings).map(
        ([value, ending]) => [value, titles.every((title) => title.endsWith(ending))] as const,
      ),
    )
  }

/**
 * The kind an `import` in a file Jest runs as CommonJS resolved as (`env/conditions-import-*`):
 * `<branch>-require` when the edge took the importer's format, `<branch>-import` when it resolved
 * as written.
 */
const edgeKindShown = shownByTitleEnding({
  'importer-format': '-require',
  'as-written': '-import',
})

/**
 * Whether an ES module's edges added `module-sync` (`env/conditions-import-module-sync`):
 * `module-sync` when they did, the `node` branch's `node-import` when they did not.
 */
const moduleSyncShown = shownByTitleEnding({
  'import-and-sync-require': ' module-sync',
  never: ' node-import',
})

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
  'module.syncMocks': each(
    own(
      'packages/dialect-jest/src/dialect.test.ts',
      'syncMocks',
      'refuse',
      "Provino's own key (B28, D7), read only under awaitFactory, which Jest's is not: its factories are synchronous, so the sync path is as it was",
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'syncMocks',
      'refuse',
      "Provino's own key (B28, D7): Vitest's mocker hooks imports only, so a require of a mocked module keeps the refusal by name",
    ),
  ),
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
  'module.mocksReachShared': mod('mod-shared-dep', 'mod-shared-dep-root'),
  // The `-esm` fixture is not evidence here: an ES module's edges are `import`s under either value.
  'module.edgeResolveKind': each(
    ['node', 'jsdom', 'custom'].map((environment) =>
      golden(`env/conditions-import-${environment}`, { read: edgeKindShown }),
    ),
    pending('T11.16', 'no Vitest fixture records how a module run as CommonJS resolves its edges'),
  ),
  // The `import` half. The `require` half is gated on whether Node evaluates an ES module graph
  // synchronously (24.9 and later under `--experimental-vm-modules`), so a recording would differ
  // between the Node versions CI runs; the loader's `edge-kind.test.ts` holds it on that seam.
  'module.moduleSyncCondition': each(
    golden('env/conditions-import-module-sync', { read: moduleSyncShown }),
    pending('T11.16', 'no Vitest fixture records a package with a `module-sync` entry'),
  ),
  // A package whose load adds or replaces a key of the global: the second file on one worker sees
  // its own evaluation's writes (Jest evaluates it again on each file's fresh global).
  'module.reevaluatePatchingExternals': each(
    [
      golden('ecosystem/load-time-global', {
        read: reevaluatedIn('sees its own evaluation of the package in the second file too'),
      }),
      golden('ecosystem/msw-setup-file', {
        read: reevaluatedIn('intercepts in the second file too'),
      }),
      golden('ecosystem/msw-node', {
        read: reevaluatedIn('intercepts with the second file’s own server'),
      }),
    ],
    golden('module/vitest-externals-two-files', {
      read: (g) =>
        [
          'the patched global is there',
          'the patching package was evaluated once for this file',
        ].every((title) => testIn(g, 'b.vitest.test.ts', title).status === 'passed'),
    }),
  ),
  'module.reevaluateHookingExternals': each(
    [
      golden('ecosystem/rtl-cleanup', {
        read: reevaluatedIn(
          'second: the first render',
          'second: a second test starts on an empty body',
        ),
      }),
      golden('ecosystem/jest-canvas-mock', {
        read: reevaluatedIn(
          'after the re-setup the context still records draw calls',
          'each test sees a fresh mock',
          'measureText still answers after the reset',
        ),
      }),
    ],
    golden('module/vitest-externals-two-files', {
      read: (g) =>
        testIn(g, 'b.vitest.test.ts', 'the package hook ran once before the first test').status ===
        'passed',
    }),
  ),
  'module.automockShape': mod('mod-automock-shape', 'mod-automock-inherited'),
  // Jest's source-map support names a failing frame after the map's name at its own position.
  'module.stackFrameNames': each(
    golden('cli/failure-frames', {
      read: (g) =>
        /\n {6}at Object\.toBe \(frames\.test\.ts:10:22\)/.test(observedOf(g).stderr ?? '')
          ? 'mapped-name'
          : 'engine',
    }),
    pending('T11.16', 'no Vitest fixture records a failing frame'),
  ),
  // A `globalSetup` patches Node's loader in the process the tests run in; each test's title holds
  // what an installed package's own `require`s got: the files on disk (the patches reached none of
  // them) or what the patches gave.
  'module.nativeLoadPatches': each(
    golden('cli/module-patch-outer-realm', {
      read: (g) => {
        const titles = g.files.flatMap((file) => file.tests.map((test) => test.id.path.join(' ')))
        return oneOf(titles, [
          ['skip', titles.includes('a .shared-runtime request gives the plain shared runtime')],
          [
            'apply',
            titles.includes(
              'a .shared-runtime request gives the vendored context the hook redirects to',
            ),
          ],
        ])
      },
    }),
    pending('T11.16', 'no Vitest fixture patches Node’s loader'),
  ),
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
  // An ES module package `transformIgnorePatterns` keep from the transform: the crash's cause is
  // the whole text (`provino`'s `transform-node-modules.test.ts` holds the run to it).
  'module.messages.require-esm': golden('cli/transform-node-modules-ignored', {
    matches: (g, value) => templateIn(value, fileErrorOf(g)),
  }),
  // Jest's error for a `moduleNameMapper` rule that matched and resolved to nothing, for a single
  // target and for a list (`resolve/mapper-miss`): the ref names the formatter, and its tests hold
  // the text to the recorded one. Vitest has no name mapper.
  'module.mapperMiss': each(
    own(
      'packages/dialect-jest/src/runtime/format-mapper-miss.test.ts',
      'a single target prints as itself',
      {
        module: import.meta.resolve('@provino/dialect-jest/runtime'),
        export: 'formatMapperMiss',
      },
      "jest-resolve's configuration error: `resolve/mapper-miss` records the text, and the provino end-to-end test holds the formatter to it",
    ),
    own(
      'packages/dialect-vitest/src/dialect.test.ts',
      'mapperMiss',
      null,
      'Vitest has no moduleNameMapper, so a miss is a not-found',
    ),
  ),
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
