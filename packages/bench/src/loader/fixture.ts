// Track 2's Spike A fixture, rebuilt from its description (the spike's gen-fixture.mjs is gone;
// see docs/plan/bundles/B06.md). 200 test files with 3 tests each, over 641 TS user modules: a
// 40-module core DAG, 40 feature groups of 15 modules (each group shared by 5 test files, with one
// m5 ↔ m6 cycle), and one state module, plus three shared node_modules packages: magic-string
// (ESM), pretty-format (CJS) and es-module-lexer (ESM + wasm). The heavy variant also loads
// `expect` in every file. Each test checks that the module state it sees is fresh for its file;
// a stale value throws an error starting with ISOLATION_VIOLATION.
//
// Test files run under Provino's loader (they export `tests`) and under Jest (they register the
// same functions with the `test` global when it exists).
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_FILES = 200
export const TESTS_PER_FILE = 3
const CORE = 40
const GROUPS = 40
const GROUP_SIZE = 15
const FILES_PER_GROUP = 5

/** The prefix of an isolation failure's message. */
export const VIOLATION = 'ISOLATION_VIOLATION'

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** `@provino/bench`'s own node_modules, where the fixture's shared packages are installed. */
const benchModules = fileURLToPath(new URL('../../node_modules', import.meta.url))

function coreModule(i: number): string {
  const deps = [i - 1, i - 2].filter((d) => d >= 0)
  return [
    ...deps.map((d) => `import { value as v${d} } from './c${pad(d)}.ts'`),
    `export const value: number = 1${deps.map((d) => ` + v${d}`).join('')}`,
    '',
  ].join('\n')
}

function groupModule(group: number, k: number): string {
  const lines: string[] = []
  if (k < GROUP_SIZE - 1) lines.push(`import { depth as next } from './m${pad(k + 1)}.ts'`)
  else lines.push(`import { value as core } from '../../core/c${pad(group % CORE)}.ts'`)
  if (k === 6) lines.push("import { name as m5Name } from './m05.ts'")
  lines.push(
    'let hits = 0',
    'export function hit(): number { return ++hits }',
    k < GROUP_SIZE - 1
      ? 'export const depth = (): number => 1 + next()'
      : 'export const depth = (): number => core',
  )
  if (k === 5) lines.push("export const name = 'm5'", "export { cycle } from './m06.ts'")
  if (k === 6) lines.push("export const cycle = (): string => 'm6 sees ' + m5Name")
  return `${lines.join('\n')}\n`
}

function testFile(index: number, heavy: boolean): string {
  const group = Math.floor(index / FILES_PER_GROUP)
  const groupDir = `../features/g${pad(group)}`
  return [
    "import MagicString from 'magic-string'",
    "import { format } from 'pretty-format'",
    "import { init, parse } from 'es-module-lexer'",
    ...(heavy ? ["import { expect } from 'expect'"] : []),
    "import { touch } from '../state.ts'",
    `import { cycle, hit } from '${groupDir}/m05.ts'`,
    `import { depth } from '${groupDir}/m00.ts'`,
    '',
    `const fail = (what: string): never => { throw new Error('${VIOLATION}: ' + what) }`,
    'export const tests: ReadonlyArray<readonly [string, () => unknown]> = [',
    "  ['state is fresh for this file', () => { if (touch() !== 1) fail('state module reused') }],",
    "  ['the feature group is fresh and its cycle is live', () => {",
    "    if (hit() !== 1) fail('feature group reused')",
    "    if (cycle() !== 'm6 sees m5') throw new Error('cycle broken: ' + cycle())",
    `    if (depth() < ${GROUP_SIZE}) throw new Error('chain too short: ' + depth())`,
    '  }],',
    "  ['shared packages work', async () => {",
    "    const s = new MagicString('abc')",
    "    s.overwrite(0, 1, 'x')",
    "    if (s.toString() !== 'xbc') throw new Error('magic-string')",
    "    if (!format({ a: 1 }).includes('\"a\": 1')) throw new Error('pretty-format')",
    '    await init',
    "    if (parse('export const a = 1')[1].length !== 1) throw new Error('es-module-lexer')",
    ...(heavy ? ['    expect({ a: [1, 2] }).toEqual({ a: [1, 2] })'] : []),
    '  }],',
    ']',
    '',
    'declare const test: ((name: string, fn: () => unknown) => void) | undefined',
    "if (typeof test === 'function') for (const [name, fn] of tests) test(name, fn)",
    '',
  ].join('\n')
}

/** Writes the fixture into `dir` and returns the test files, in order. */
export function writeLoaderFixture(dir: string, options: { readonly heavy: boolean }): string[] {
  const write = (path: string, content: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  symlinkSync(benchModules, join(dir, 'node_modules'), 'dir')
  write('state.ts', 'let n = 0\nexport function touch(): number { return ++n }\n')
  for (let i = 0; i < CORE; i++) write(`core/c${pad(i)}.ts`, coreModule(i))
  for (let g = 0; g < GROUPS; g++) {
    for (let k = 0; k < GROUP_SIZE; k++)
      write(`features/g${pad(g)}/m${pad(k)}.ts`, groupModule(g, k))
  }
  const files: string[] = []
  for (let i = 0; i < FIXTURE_FILES; i++) {
    const path = `tests/t${pad(i, 3)}.test.ts`
    write(path, testFile(i, options.heavy))
    files.push(join(dir, path))
  }
  return files
}
