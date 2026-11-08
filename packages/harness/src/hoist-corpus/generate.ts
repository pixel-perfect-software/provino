// Seeded statement layouts for the hoist corpus. The vendored and authored inputs name the shapes
// someone thought of; a layout bug (B13b's `moveBefore`) hides in the ones nobody did, like the
// statement that happens to touch the anchor. Every case comes from `seed` alone, so a failure names
// a case that reproduces.
import { type HoistCase, plainCase } from './check.ts'
import type { RunnerName } from './run-recorded.ts'

/** A small generator with a fixed sequence (a linear congruential one, on 31 bits). */
class Sequence {
  #state: number

  constructor(seed: number) {
    this.#state = seed
  }

  next(limit: number): number {
    this.#state = (Math.imul(this.#state, 1103515245) + 12345) & 0x7fffffff
    return (this.#state >>> 12) % limit
  }

  pick<T>(items: readonly [T, ...T[]]): T {
    return items[this.next(items.length)] ?? items[0]
  }
}

/** What goes between statements: every one ends a statement, so none joins two by accident. */
const SEPARATORS = ['\n', '\n', '\n', ';\n', ';', '; ', '\r\n', '\n\n'] as const
/**
 * Only under Jest. Vitest moves a call with no semicolon and leaves the comment and its line end, so
 * the next statement lands on the same line and its output doesn't parse.
 */
const JEST_SEPARATORS = [...SEPARATORS, ' // c\n'] as const
/** Few modules, so a mock and an import often name the same one. */
const MODULES = ['./a', './b', './c', './d'] as const

interface Layout {
  readonly rnd: Sequence
  readonly statements: string[]
  imported: string[]
  consts: number
  names: number
}

function fresh(layout: Layout, prefix: string): string {
  layout.names++
  return `${prefix}${layout.names}`
}

function someImport(layout: Layout): string {
  const name = layout.imported[layout.rnd.next(Math.max(layout.imported.length, 1))]
  return name ?? 'other'
}

type Statement = (layout: Layout) => string

/** Statements that mean the same to both runners. */
const SHARED: readonly [Statement, ...Statement[]] = [
  (l) => {
    const name = fresh(l, 'i')
    l.imported.push(name)
    return `import ${name} from "${l.rnd.pick(MODULES)}"`
  },
  (l) => {
    const name = fresh(l, 'n')
    l.imported.push(name)
    return `import { ${name} } from "${l.rnd.pick(MODULES)}"`
  },
  (l) => {
    const name = fresh(l, 's')
    l.imported.push(name)
    return `import * as ${name} from "${l.rnd.pick(MODULES)}"`
  },
  (l) => `import "${l.rnd.pick(MODULES)}"`,
  (l) => `stay${l.statements.length}()`,
  (l) => `use(${someImport(l)})`,
  (l) => `const ${fresh(l, 'k')} = ${someImport(l)}`,
  (l) => `function ${fresh(l, 'g')}() { return ${someImport(l)} }`,
  (l) => `test("t", () => { use(${someImport(l)}) })`,
  (l) => `export const ${fresh(l, 'e')} = ${l.statements.length}`,
  (l) => `export { ${fresh(l, 'r')} } from "${l.rnd.pick(MODULES)}"`,
  (l) => `const ${fresh(l, 'q')} = require("${l.rnd.pick(MODULES)}")`,
  () => ';[1, 2].forEach(stay)',
  () => ';(stay)()',
]

const JEST: readonly [Statement, ...Statement[]] = [
  (l) => `jest.mock("${l.rnd.pick(MODULES)}")`,
  (l) => `jest.mock("${l.rnd.pick(MODULES)}")`,
  (l) => `jest.mock("${l.rnd.pick(MODULES)}", () => ({ v: 1 }))`,
  (l) => {
    const name = `c${l.consts++}`
    // The const first, in its own statement: the plugin moves it with the call.
    return `const ${name} = ${l.consts}\njest.mock("${l.rnd.pick(MODULES)}", () => ${name})`
  },
  (l) => `jest.unmock("${l.rnd.pick(MODULES)}")`,
  (l) => `jest.doMock("${l.rnd.pick(MODULES)}")`,
  (l) => `jest.mock("${l.rnd.pick(MODULES)}").unmock("${l.rnd.pick(MODULES)}")`,
  () => 'jest.enableAutomock()',
  (l) => `describe("d", () => {\n  stay()\n  jest.mock("${l.rnd.pick(MODULES)}")\n  stay()\n})`,
  (l) => `jest.mock("${l.rnd.pick(MODULES)}", () => ${fresh(l, 'mock')})`,
]

const VITEST: readonly [Statement, ...Statement[]] = [
  (l) => `vi.mock("${l.rnd.pick(MODULES)}")`,
  (l) => `vi.mock("${l.rnd.pick(MODULES)}")`,
  (l) => `vi.mock("${l.rnd.pick(MODULES)}", () => ({ v: ${someImport(l)} }))`,
  (l) => `vi.mock(import("${l.rnd.pick(MODULES)}"))`,
  (l) => `vi.unmock("${l.rnd.pick(MODULES)}")`,
  (l) => `vi.doMock("${l.rnd.pick(MODULES)}")`,
  (l) => {
    const name = `h${l.consts++}`
    return `const ${name} = vi.hoisted(() => ${l.consts})`
  },
  (l) => {
    if (l.consts === 0) return 'vi.hoisted(() => stay())'
    const name = `h${l.consts}`
    const previous = `h${l.consts - 1}`
    l.consts++
    return `const ${name} = vi.hoisted(() => ${previous} + 1)`
  },
  () => 'vi.hoisted(() => stay())',
]

function generate(rnd: Sequence, runner: RunnerName): string {
  const layout: Layout = { rnd, statements: [], imported: [], consts: 0, names: 0 }
  const count = 1 + rnd.next(8)
  const own = runner === 'jest' ? JEST : VITEST
  for (let index = 0; index < count; index++) {
    // Half are the runner's own, so most files have something to hoist.
    const pool = rnd.next(2) === 0 ? own : SHARED
    layout.statements.push(rnd.pick(pool)(layout))
  }
  const separators = runner === 'jest' ? JEST_SEPARATORS : SEPARATORS
  let code = ''
  for (const statement of layout.statements) {
    code += statement
    // A node that Vitest moves whole ends at the next `;`, even on a later line, so a `;[1]` below
    // would lose its guard and join the line before. Its own `;` closes it first; ours keeps the
    // guard either way (D7), which `inputs.ts` shows under Jest.
    if (runner === 'vitest' && /^(?:import |const h)/.test(statement)) code += ';'
    code += separators[rnd.next(separators.length)] ?? '\n'
  }
  // A file's last line ends, as `group` in `inputs.ts` explains.
  return `${code}\n`
}

/** `count` layouts for `runner`, the same ones every run. */
export function generateLayouts(
  runner: RunnerName,
  count: number,
  seed: number,
): readonly HoistCase[] {
  const rnd = new Sequence(seed)
  const out: HoistCase[] = []
  for (let index = 0; index < count; index++) {
    out.push(plainCase(`generated ${runner} #${index}`, generate(rnd, runner)))
  }
  return out
}
