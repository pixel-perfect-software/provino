// Spike B's `jest.config.ts` (Track 11 L562), rebuilt from that line (`bundles/B14.md` → Corpus
// rebuilds 1): `preset: 'ts-jest'`, a `moduleNameMapper` with a `string[]` target, a
// `[ts-jest, opts]` transform tuple and `coverageThreshold`; 7 keys, as the spike's raw object
// had. Written as data at run time (D13): no `.ts` config is committed under a package's tree.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The fixture's `jest.config.ts`. */
export const SPIKE_B_CONFIG = `import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^@app/(.*)$': ['<rootDir>/src/$1', '<rootDir>/lib/$1'],
  },
  transform: {
    '^.+\\\\.tsx?$': ['ts-jest', { isolatedModules: true, diagnostics: false }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}

export default config
`

/** How many top-level keys the fixture's config has (the spike's raw object had 7). */
export const SPIKE_B_KEYS = 7

/** Writes the fixture into a fresh temp dir and returns the dir. */
export function writeSpikeBFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-jest-config-spike-b-')))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'jest.config.ts'), SPIKE_B_CONFIG)
  writeFileSync(join(dir, 'package.json'), '{ "name": "spike-b", "private": true }\n')
  return dir
}
