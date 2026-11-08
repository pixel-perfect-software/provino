// `pnpm bench:jest-config presets`: T11.5 on real presets. ts-jest (and its ESM and js-with-ts
// presets), `@react-native/jest-preset`, jest-expo (and a platform preset), jest-preset-angular,
// and a relative monorepo preset, each read by ours and by real jest-config 30.5.2 and compared
// on the 55 keys (`compare.ts`); every other key is reported. The presets are installed in
// `packages/dialect-jest/oracle/presets/` (its own pnpm root, pinned by its lockfile):
//   pnpm --dir packages/dialect-jest/oracle/presets install --frozen-lockfile
// Each case is a small project written into that directory's `.work/` (gitignored), so it
// resolves the presets from there. Runs in CI as the `jest-oracles` job. Every number is `local`.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brief, compareReads, type KeyDifference } from './compare.ts'
import { type ReadOutcome, readWithJest, readWithProvino } from './oracle.ts'

/** Where the presets are installed. */
export const PRESETS_DIR: string = fileURLToPath(
  new URL('../../../dialect-jest/oracle/presets/', import.meta.url),
)

/** One preset case: files of a small project, and the config to read (relative to it). */
export interface PresetCase {
  readonly name: string
  readonly files: Readonly<Record<string, string>>
  readonly config: string
}

const js = (body: string): string => `module.exports = ${body}\n`

/** The cases. A preset name with no `jest-preset` file (react-native's) must fail on both sides. */
export const PRESET_CASES: readonly PresetCase[] = [
  {
    name: 'ts-jest',
    files: { 'jest.config.js': js(`{ preset: 'ts-jest' }`) },
    config: 'jest.config.js',
  },
  {
    name: "ts-jest with the config's own keys over it",
    files: {
      'jest.config.js': js(
        `{ preset: 'ts-jest', testEnvironment: 'node', roots: ['<rootDir>/src'], moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' }, transform: { '^.+\\\\.tsx?$': ['ts-jest', { isolatedModules: true }] }, setupFilesAfterEnv: ['<rootDir>/setup.ts'] }`,
      ),
      'src/x.ts': '',
      'setup.ts': '',
    },
    config: 'jest.config.js',
  },
  {
    name: 'ts-jest/presets/default-esm',
    files: { 'jest.config.js': js(`{ preset: 'ts-jest/presets/default-esm' }`) },
    config: 'jest.config.js',
  },
  {
    name: 'ts-jest/presets/js-with-ts',
    files: {
      'jest.config.js': js(`{ preset: 'ts-jest/presets/js-with-ts', testEnvironment: 'node' }`),
    },
    config: 'jest.config.js',
  },
  {
    name: '@react-native/jest-preset',
    files: { 'jest.config.js': js(`{ preset: '@react-native/jest-preset' }`) },
    config: 'jest.config.js',
  },
  {
    name: '@react-native/jest-preset with setupFiles and transformIgnorePatterns',
    files: {
      'jest.config.js': js(
        `{ preset: '@react-native/jest-preset', setupFiles: ['<rootDir>/jest.setup.js'], setupFilesAfterEnv: ['<rootDir>/after.js'], transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?)/)'], moduleNameMapper: { '\\\\.svg$': '<rootDir>/svg-mock.js' } }`,
      ),
      'jest.setup.js': '',
      'after.js': '',
      'svg-mock.js': '',
    },
    config: 'jest.config.js',
  },
  {
    name: 'react-native (0.88 ships no jest-preset)',
    files: { 'jest.config.js': js(`{ preset: 'react-native' }`) },
    config: 'jest.config.js',
  },
  {
    name: 'jest-expo',
    files: { 'jest.config.js': js(`{ preset: 'jest-expo' }`) },
    config: 'jest.config.js',
  },
  {
    name: "jest-expo/ios with the config's transformIgnorePatterns",
    files: {
      'jest.config.js': js(
        `{ preset: 'jest-expo/ios', transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*)'] }`,
      ),
    },
    config: 'jest.config.js',
  },
  {
    name: 'jest-preset-angular',
    files: {
      'jest.config.js': js(
        `{ preset: 'jest-preset-angular', setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'] }`,
      ),
      'setup-jest.ts': '',
    },
    config: 'jest.config.js',
  },
  {
    name: 'a relative monorepo preset that spreads ts-jest',
    files: {
      'jest.preset.js': js(
        `{ ...require('ts-jest/presets').defaults, testEnvironment: 'node', setupFiles: ['<rootDir>/../../tools/setup.js'], moduleNameMapper: { '^@org/(.*)$': '<rootDir>/../../libs/$1/src' } }`,
      ),
      'tools/setup.js': '',
      'packages/app/jest.config.js': js(
        `{ preset: '../../jest.preset.js', displayName: 'app', moduleNameMapper: { '^~/(.*)$': '<rootDir>/src/$1' } }`,
      ),
    },
    config: 'packages/app/jest.config.js',
  },
]

/** One case's result. */
export interface PresetResult {
  readonly name: string
  readonly ours: ReadOutcome
  readonly theirs: ReadOutcome
  readonly bar: readonly KeyDifference[]
  readonly other: readonly KeyDifference[]
  /** Both read, or both failed with the same text, and no bar key differs. */
  readonly agrees: boolean
}

function slug(name: string): string {
  return name
    .replaceAll(/[^a-z0-9]+/gi, '-')
    .replaceAll(/^-|-$/g, '')
    .toLowerCase()
}

async function inDirectory<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(before)
  }
}

/** Runs one case in `.work/` and compares the two sides. */
export async function runPresetCase(fixture: PresetCase): Promise<PresetResult> {
  const root = join(PRESETS_DIR, '.work', slug(fixture.name))
  rmSync(root, { recursive: true, force: true })
  for (const [path, text] of Object.entries(fixture.files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const config = join(root, fixture.config)
  const cwd = dirname(config)
  const theirs = await inDirectory(cwd, () => readWithJest(config))
  const ours = await inDirectory(cwd, () => readWithProvino(config))
  if (ours.ok && theirs.ok) {
    const { bar, other } = compareReads(ours.read, theirs.read)
    return { name: fixture.name, ours, theirs, bar, other, agrees: bar.length === 0 }
  }
  const agrees = !ours.ok && !theirs.ok && ours.error === theirs.error
  return { name: fixture.name, ours, theirs, bar: [], other: [], agrees }
}

function describeFailure(outcome: ReadOutcome): string {
  return outcome.ok ? 'read' : `failed: ${outcome.error.split('\n').slice(0, 4).join(' ⏎ ')}`
}

/** The command: every case, printed, exit 1 if any disagrees. */
export async function presetsCommand(args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`bench:jest-config presets takes no options (got ${args.join(' ')})\n`)
    return 2
  }
  if (!existsSync(join(PRESETS_DIR, 'node_modules'))) {
    process.stderr.write(
      `bench:jest-config presets: the presets aren't installed; run\n  pnpm --dir ${PRESETS_DIR} install --frozen-lockfile\n`,
    )
    return 1
  }
  const lines = [
    `jest-config presets (local, Node ${process.version}, ${PRESET_CASES.length} cases, 55 keys each)`,
  ]
  let failed = 0
  for (const fixture of PRESET_CASES) {
    const result = await runPresetCase(fixture)
    if (!result.agrees) failed++
    const status = result.agrees ? 'ok  ' : 'FAIL'
    const what =
      result.ours.ok && result.theirs.ok
        ? `equal on the 55 keys${result.other.length > 0 ? `; other keys differ: ${result.other.map((d) => d.key).join(', ')}` : ''}`
        : `ours ${describeFailure(result.ours)}; jest-config ${describeFailure(result.theirs)}`
    lines.push(`  ${status} ${result.name}: ${what}`)
    for (const difference of result.bar) {
      lines.push(
        `       ${difference.key}: ours ${brief(difference.ours)} jest ${brief(difference.theirs)}`,
      )
    }
  }
  lines.push(
    failed === 0
      ? `all ${PRESET_CASES.length} agree`
      : `FAIL ${failed} of ${PRESET_CASES.length} disagree`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return failed === 0 ? 0 : 1
}
