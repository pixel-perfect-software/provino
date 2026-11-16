// A package under `node_modules` that a transform claims and `transformIgnorePatterns` lets through
// (B23e, D115): Jest 30.5.2 transforms every such module, so an ES module package with an
// extensionless relative import works there, where Node's own loader finds no file. Provino
// transforms and evaluates such a file per file as a user module when Node can't load it natively
// (ES module syntax, a TypeScript or JSX extension, or a native load that fails to parse), and
// leaves any other CommonJS one on the native path. Each fixture is run through `provino jest` and
// held to what Jest recorded for it (`cli/transform-node-modules-*`: the exit code and the kept
// stderr lines), with Provino's Oxc path standing in for the default `babel-jest` entry, or the
// recorder's own transform when the fixture's Babel config makes it explicit (`-cjs-jsx`).
import { describe, it } from 'node:test'
import { assertMatchesGolden, provinoOn } from './recorded-run.ts'

const FIXTURES = [
  [
    'cli/transform-node-modules-allowlist',
    "next/jest's patterns let esm-pkg through: transformed, its ./config found by extension",
  ],
  ['cli/transform-node-modules-all', 'patterns that ignore no package: esm-pkg is transformed'],
  [
    'cli/transform-node-modules-ignored',
    "Jest's default patterns keep esm-pkg out: Jest's Must use import to load ES Module",
  ],
  [
    'cli/transform-node-modules-cjs',
    'a claimed CommonJS package stays on the native path, and passes',
  ],
  [
    'cli/transform-node-modules-cjs-jsx',
    "a claimed CommonJS package Node can't parse (JSX, Flow) goes through the project's transform, and passes",
  ],
  [
    'cli/transform-node-modules-asset',
    "a claimed asset (a package's own .css file) goes through the claiming transform, as in Jest, and passes",
  ],
] as const

describe('node_modules files a transform claims, against Jest 30.5.2', () => {
  for (const [id, title] of FIXTURES) {
    it(`${id}: ${title}`, async () => {
      assertMatchesGolden(id, await provinoOn(id))
    })
  }
})
