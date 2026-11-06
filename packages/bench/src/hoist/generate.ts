// The input of `bench:hoist` (T3.4's cost bar): a generated ESM test file of about 15 KB, once with
// mock calls and once without. Seeded, so every run and every machine times the same text. The
// mocked file is the worst case for the hoister: many static imports, mocks below them, and test
// bodies that read the imported bindings (each read is a rewrite).

/** A small seeded generator (mulberry32): the same seed gives the same numbers. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GenerateOptions {
  readonly seed: number
  /** Whether the file calls `jest.mock`. The unmocked file has no call a hoister looks for. */
  readonly mocked: boolean
  /** The file is at least this many bytes. */
  readonly targetBytes: number
}

/** The statements the hoister reacts to; the unmocked file must hold none of them. */
export const HOIST_CALL_PATTERN: RegExp =
  /\b(?:mock|unmock|deepUnmock|enableAutomock|disableAutomock)\s*\(/

const MODULES = 24

function names(index: number): { readonly fn: string; readonly value: string } {
  return { fn: `fn${index}`, value: `value${index}` }
}

/** A test file for the hoist bench. */
export function generateTestFile(options: GenerateOptions): string {
  const random = seededRandom(options.seed)
  const pick = (n: number): number => Math.floor(random() * n)
  const lines: string[] = []

  for (let i = 0; i < MODULES; i++) {
    const { fn, value } = names(i)
    lines.push(`import { ${fn}, ${value} } from './modules/mod-${i}.ts'`)
  }
  lines.push("import fallback from './modules/fallback.ts'")
  lines.push("import * as helpers from './modules/helpers.ts'")
  lines.push('')

  // Half the modules are mocked: with a factory, or with the automock form.
  for (let i = 0; i < MODULES; i += 2) {
    const { fn, value } = names(i)
    if (options.mocked) {
      lines.push(
        i % 4 === 0
          ? `jest.mock('./modules/mod-${i}.ts', () => ({ ${fn}: jest.fn(), ${value}: ${i} }))`
          : `jest.mock('./modules/mod-${i}.ts')`,
      )
    } else {
      lines.push(
        `const stubs${i} = { ${fn}: jest.fn(), ${value}: ${i}, path: './modules/mod-${i}.ts' }`,
      )
    }
  }
  lines.push('')

  for (let suite = 0; lines.join('\n').length < options.targetBytes; suite++) {
    lines.push(`describe('suite ${suite}', () => {`)
    lines.push('  beforeEach(() => {')
    lines.push(`    ${names(pick(MODULES)).fn}.mockClear?.()`)
    lines.push('  })')
    for (let c = 0; c < 4; c++) {
      const a = names(pick(MODULES))
      const b = names(pick(MODULES))
      lines.push(`  it('case ${suite}.${c} reads ${a.value}', () => {`)
      lines.push(`    const input = ${a.value} + ${b.value} + ${pick(1000)}`)
      lines.push(`    const out = ${a.fn}(input, helpers.pad(${pick(50)}), fallback)`)
      lines.push(`    expect(${a.fn}).toHaveBeenCalledTimes(${pick(3)})`)
      lines.push(`    expect(typeof out).toBe('${random() < 0.5 ? 'undefined' : 'object'}')`)
      lines.push('  })')
    }
    lines.push('})')
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
