/**
 * The two source flavours every suite is generated in, from one model. `cjs` is CommonJS, which
 * Jest runs at its defaults with no ESM flags. `esm` is ES modules, which `vi.mock` needs: it
 * can't intercept `require`, and Vite can't inline CommonJS source.
 * @public
 */
export type Flavour = 'cjs' | 'esm'

/**
 * The flavours in generation order.
 * @public
 */
export const FLAVOURS: readonly Flavour[] = ['cjs', 'esm']

/**
 * The directory a flavour's tree lives in under the suite: `jest/` for CommonJS, `vitest/` for
 * ESM.
 * @public
 */
export const FLAVOUR_DIR: Readonly<Record<Flavour, string>> = { cjs: 'jest', esm: 'vitest' }

/**
 * One generated file. `path` is relative to the suite directory and uses `/`.
 * @public
 */
export interface GeneratedFile {
  readonly path: string
  readonly contents: string
}

/**
 * A module import, rendered as `require` or `import` depending on the flavour.
 * @public
 */
export type Binding =
  | { readonly kind: 'named'; readonly names: readonly string[]; readonly from: string }
  | { readonly kind: 'default'; readonly name: string; readonly from: string }
  | { readonly kind: 'namespace'; readonly name: string; readonly from: string }

/**
 * Renders one import for the flavour.
 * @public
 */
export function renderImport(flavour: Flavour, binding: Binding): string {
  const from = `'${binding.from}'`
  switch (binding.kind) {
    case 'named': {
      const names = binding.names.join(', ')
      return flavour === 'cjs'
        ? `const { ${names} } = require(${from})`
        : `import { ${names} } from ${from}`
    }
    case 'default':
      return flavour === 'cjs'
        ? `const ${binding.name} = require(${from})`
        : `import ${binding.name} from ${from}`
    case 'namespace':
      return flavour === 'cjs'
        ? `const ${binding.name} = require(${from})`
        : `import * as ${binding.name} from ${from}`
  }
}

/**
 * Renders the export of already-declared names for the flavour.
 * @public
 */
export function renderExports(flavour: Flavour, names: readonly string[]): string {
  const list = names.join(', ')
  return flavour === 'cjs' ? `module.exports = { ${list} }` : `export { ${list} }`
}

/**
 * The `'use strict'` prologue CommonJS files start with, and nothing for ES modules.
 * @public
 */
export function prologue(flavour: Flavour): readonly string[] {
  return flavour === 'cjs' ? ["'use strict'", ''] : []
}

/**
 * Joins lines into a file: LF endings and one trailing newline.
 * @public
 */
export function lines(parts: readonly string[]): string {
  return `${parts.join('\n')}\n`
}

/**
 * Pads an index to a fixed width for file names, so names sort in order.
 * @public
 */
export function pad(index: number, width: number): string {
  return String(index).padStart(width, '0')
}

/**
 * The most test files a suite can have: file names carry four digits (`app-0000.test.js`).
 * @public
 */
export const MAX_SUITE_FILES = 9999

/**
 * `count` test files under `<dir>/tests/`, named `<prefix>-<index>.test.js` with the index padded
 * to `width` digits, each holding what `render(index)` returns.
 * @public
 */
export function testFiles(
  dir: string,
  prefix: string,
  count: number,
  render: (index: number) => string,
  width = 4,
): readonly GeneratedFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `${dir}/tests/${prefix}-${pad(index, width)}.test.js`,
    contents: render(index),
  }))
}

/**
 * Pretty-printed JSON with a trailing newline.
 * @public
 */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * The isolation tiers Provino can be planned at: the two the kill-check compares (R6).
 * @public
 */
export type ProvinoIsolation = 'registry' | 'none'

/**
 * Each Provino tier's config file in the `jest/` tree.
 * @public
 */
export const PROVINO_CONFIG: Readonly<Record<ProvinoIsolation, string>> = {
  registry: 'provino.config.mjs',
  none: 'provino.none.config.mjs',
}

const PROVINO_ISOLATIONS = Object.keys(PROVINO_CONFIG) as ProvinoIsolation[]

/**
 * The files every suite shares, per flavour: the package manifest, the runner config, the setup
 * file, and for the Jest tree the Provino config.
 *
 * `provino.config.mjs` says the same as the tree's `jest.config.json`: the Jest dialect, the
 * `testMatch` as `include`, and the `setupFilesAfterEnv` as the neutral `setupFiles` (which run
 * after the environment). It states `isolation: 'registry'` explicitly, and
 * `provino.none.config.mjs` is the same with `isolation: 'none'`, for the kill-check's registry/none
 * ratio. R6 fixes the registry tier, and build-plan section 4 item 34 warns that Jest's default
 * could move to `realm`: an explicit config stops the kill-check from silently measuring a
 * different tier.
 *
 * They are `.mjs` because the tree's `package.json` is CommonJS, which can't load an
 * `export default` from a `.ts` file; they are generated into the gitignored `.suites/`, like the
 * suites' other `.js` files, so the repository holds no `.js` or `.mjs` (D13).
 *
 * The setup file registers a custom matcher with `expect.extend` and global `beforeEach` and
 * `afterEach` hooks that count their calls. It uses only globals, so it is the same bytes in both
 * flavours.
 * @public
 */
export function commonFiles(suite: string, flavour: Flavour): readonly GeneratedFile[] {
  const dir = FLAVOUR_DIR[flavour]
  const file = (name: string, contents: string): GeneratedFile => ({
    path: `${dir}/${name}`,
    contents,
  })
  const setup = file(
    'setup.js',
    lines([
      'globalThis.benchHooks = { before: 0, after: 0 }',
      '',
      'expect.extend({',
      '  toBeWithinRange(received, floor, ceiling) {',
      "    const pass = typeof received === 'number' && received >= floor && received <= ceiling",
      '    return {',
      '      pass,',
      "      message: () => 'expected ' + received + (pass ? ' not' : '') + ' to be within ' + floor + ' and ' + ceiling,",
      '    }',
      '  },',
      '})',
      '',
      'beforeEach(() => {',
      '  globalThis.benchHooks.before += 1',
      '})',
      '',
      'afterEach(() => {',
      '  globalThis.benchHooks.after += 1',
      '})',
    ]),
  )
  const provinoConfig = (isolation: ProvinoIsolation): GeneratedFile =>
    file(
      PROVINO_CONFIG[isolation],
      lines([
        'export default {',
        "  dialect: 'jest',",
        `  isolation: '${isolation}',`,
        "  include: ['tests/**/*.test.js'],",
        "  setupFiles: ['./setup.js'],",
        '}',
      ]),
    )
  if (flavour === 'cjs') {
    return [
      file('package.json', json({ name: `bench-${suite}-jest`, private: true, type: 'commonjs' })),
      file(
        'jest.config.json',
        json({
          testEnvironment: 'node',
          testMatch: ['<rootDir>/tests/**/*.test.js'],
          setupFilesAfterEnv: ['<rootDir>/setup.js'],
          cacheDirectory: '<rootDir>/../.cache/jest',
        }),
      ),
      ...PROVINO_ISOLATIONS.map(provinoConfig),
      setup,
    ]
  }
  return [
    file('package.json', json({ name: `bench-${suite}-vitest`, private: true, type: 'module' })),
    file(
      'vitest.config.ts',
      lines([
        'export default {',
        "  cacheDir: '../.cache/vite',",
        '  test: {',
        '    globals: true,',
        "    environment: 'node',",
        "    include: ['tests/**/*.test.js'],",
        "    setupFiles: ['./setup.js'],",
        '  },',
        '}',
      ]),
    ),
    setup,
  ]
}
