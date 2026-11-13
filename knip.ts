// knip (T1.6): unused files and dependencies, dependencies a file uses but its package.json
// doesn't list, and imports that don't resolve. `pnpm hygiene` runs it and fails on any of those.
// Unused *exports* and exported *types* are reported as warnings: the tree has a baseline of them
// (mostly vendored upstream code and helpers exported for tests), and clearing it is a cleanup
// of every package, not packaging. `pnpm knip` prints them.
//
// `ignoreDependencies` below holds only what a static read of the imports can't see: packages
// that are loaded by name at run time, run as tools, or bundled into `provino`. Each says why.
import type { KnipConfig } from 'knip'
import { readManifest } from './tooling/packaging/src/package-json.ts'

const config: KnipConfig = {
  rules: {
    exports: 'warn',
    types: 'warn',
    nsExports: 'warn',
    nsTypes: 'warn',
    duplicates: 'warn',
    enumMembers: 'off',
  },
  ignore: [
    // Fixtures the recorder or the corpus runs as projects: they import packages the recorder
    // installs at run time and modules that are meant to be missing.
    '**/fixtures/**',
    'packages/harness/sample/**',
    // Vendored upstream code (rules/vendored-upstream.md): kept as upstream wrote it.
    '**/vendor/**',
  ],
  workspaces: {
    '.': {
      ignoreDependencies: [
        // Run as tools by `tooling/packaging` (`node <bin>`) and by root scripts.
        '@arethetypeswrong/cli',
        '@microsoft/api-extractor',
        // The TypeScript 6 API that dependency-cruiser and API Extractor load under `typescript`.
        '@typescript/typescript6',
        'dependency-cruiser',
      ],
    },
    'tooling/boundaries': {
      // Declared by the package map (its manifest node lists them); not imported by a source file.
      ignoreDependencies: ['@provino/types'],
    },
    'packages/bench': {
      // The runners and libraries the generated benchmark suites and the baselines install or import.
      ignoreDependencies: [
        '@swc/core',
        '@swc/jest',
        'date-fns',
        'es-module-lexer',
        'jest',
        'lodash',
        'magic-string',
        'pretty-format',
        'vitest',
        'zod',
      ],
      // A system tool, not a package: `provino-bench instructions` runs it on Linux (T12.13).
      ignoreBinaries: ['valgrind'],
    },
    'packages/harness': {
      // Subjects the recorder runs (real Jest and Vitest), and Babel plugins its Jest config names.
      ignoreDependencies: [
        '@babel/plugin-transform-modules-commonjs',
        '@babel/preset-react',
        'babel-plugin-jest-hoist',
        'jest',
        'jest-environment-node',
        'jest-serializer-vue',
      ],
    },
    'packages/transform': {
      // Babel plugins and presets the hoist corpus and T3.8's fixture name as strings.
      ignoreDependencies: ['@babel/plugin-transform-modules-commonjs', '@babel/preset-typescript'],
    },
    'packages/dialect-jest': {
      // Environment packages the adapter tests load by name (T8.5).
      ignoreDependencies: ['jest-environment-jsdom-29', 'jest-fixed-jsdom'],
    },
    'packages/snapshot': {
      // The oracle for the vendored key order (T7.9), required by a test through `createRequire`.
      ignoreDependencies: ['natural-compare'],
    },
    'packages/lazy': {
      // The type-check tests run its `bin/tsc` found by path (`test/support/tsc.ts`), which knip can't see.
      ignoreDependencies: ['typescript-5.9'],
    },
    'packages/core': { ignoreDependencies: ['@types/sinonjs__fake-timers'] },
    'packages/timers': { ignoreDependencies: ['@types/sinonjs__fake-timers'] },
    'packages/coverage': {
      // Declared by the package map; the instrumenter and collectors that import it are B23b Phase 2.
      ignoreDependencies: ['@provino/types'],
    },
    'packages/env-shared': {
      // Declared by the package map; not imported yet.
      ignoreDependencies: ['@provino/types'],
    },
    'packages/orchestrator': {
      // Named in a doc comment (the `@jest-environment jsdom` pragma), which knip reads as an import.
      ignoreDependencies: ['jest-environment-jsdom'],
    },
    'packages/provino': {
      ignoreDependencies: [
        // Every dependency of `provino`: the packages it inlines import them and the build leaves
        // them external, so no file of its own does, and after a build knip also reads its
        // declarations (dist/*.d.ts), which import some of them, but not others. The list is the
        // manifest's, so it can't drift: `pnpm hygiene` (umbrella-deps) proves each is needed by
        // an inlined package, and tsdown's `onlyImport` fails a build that imports one it lacks.
        // One pattern, not one entry per name: which of them dist/*.d.ts imports depends on
        // whether a build has run, and knip would hint at the others as needless on one side.
        new RegExp(
          `^(?:${Object.keys(readManifest('packages/provino').dependencies)
            .map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
            .join('|')})$`,
        ),
        // A test symlinks a real jest-environment-jsdom into a project.
        'jest-environment-jsdom',
      ],
    },
  },
}

export default config
