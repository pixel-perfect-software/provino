// A fixed TypeScript corpus for T3.12's transform, resolve and warm-cache numbers. Track 3's spike
// corpora (excalidraw, the TS conformance files) live outside the repo; a guard needs inputs that
// never change with a pull request and need no download, so this is generated from a seed, like
// the suites. Each file is a few KB of ordinary application TypeScript: imports of other corpus
// files (with and without the `.ts` extension, so resolution has extensions to try), of installed
// packages and of Node builtins; interfaces, type aliases, generics, an enum, a class with private
// state, async functions, optional chaining, template literals, `satisfies` and `as const`.
import { pickDistinct, randomBelow, seededRandom } from '../internal/prng.ts'
import type { GeneratedFile } from './render.ts'

/**
 * Files in the corpus.
 * @public
 */
export const TS_CORPUS_FILES = 120

/**
 * The corpus's seed: changing it changes every instruction count, so it never changes.
 * @public
 */
export const TS_CORPUS_SEED = 3_120_001

/** Packages a corpus file may import; each is installed in the bench package. */
const PACKAGES: readonly (readonly [string, string])[] = [
  [
    "import { addDays, format } from 'date-fns'",
    'format(addDays(new Date(0), seed), "yyyy-MM-dd")',
  ],
  ["import { chunk, sortBy } from 'lodash'", 'chunk(sortBy([3, 1, 2]), 2).length + seed'],
  ["import { z } from 'zod'", 'z.number().parse(seed)'],
]

/** Node builtins a corpus file may import. */
const BUILTINS: readonly (readonly [string, string])[] = [
  ["import { join } from 'node:path'", "join('a', String(seed))"],
  [
    "import { createHash } from 'node:crypto'",
    "createHash('sha1').update(String(seed)).digest('hex')",
  ],
]

const pad = (n: number): string => String(n).padStart(3, '0')

/** One module: its imports (each other corpus file it uses) and a body built from `random`. */
function module(index: number, random: () => number): string {
  const lines: string[] = []
  const deps =
    index === 0 ? [] : pickDistinct(random, index, Math.min(index, 1 + randomBelow(random, 3)))
  for (const dep of deps) {
    const extension = randomBelow(random, 2) === 0 ? '.ts' : ''
    lines.push(
      `import { score as score${pad(dep)}, type Record${pad(dep)} } from './m${pad(dep)}${extension}'`,
    )
  }
  const pkg = PACKAGES[randomBelow(random, PACKAGES.length + 2)]
  if (pkg !== undefined) lines.push(pkg[0])
  const builtin = BUILTINS[randomBelow(random, BUILTINS.length + 3)]
  if (builtin !== undefined) lines.push(builtin[0])
  const name = `Record${pad(index)}`
  const fields = 3 + randomBelow(random, 4)
  lines.push(
    '',
    `export enum Kind${pad(index)} {`,
    ...Array.from({ length: 3 }, (_, k) => `  Variant${k} = '${index}-${k}',`),
    '}',
    '',
    `export interface ${name} {`,
    `  readonly id: number`,
    `  readonly kind: Kind${pad(index)}`,
    ...Array.from(
      { length: fields },
      (_, k) => `  readonly field${k}?: ${k % 2 === 0 ? 'string' : 'number'} | undefined`,
    ),
    '}',
    '',
    `export type Partial${pad(index)}<T extends ${name}> = { readonly [K in keyof T]?: T[K] | null }`,
    '',
    `const DEFAULTS = { limit: ${10 + randomBelow(random, 90)}, label: 'm${pad(index)}' } as const satisfies Readonly<Record<string, string | number>>`,
    '',
    `export class Store${pad(index)}<T extends ${name} = ${name}> {`,
    '  readonly #items = new Map<number, T>()',
    `  #version: number = 0`,
    '',
    '  constructor(private readonly prefix: string = DEFAULTS.label) {}',
    '',
    '  add(item: T): this {',
    '    this.#items.set(item.id, item)',
    '    this.#version++',
    '    return this',
    '  }',
    '',
    '  find(predicate: (item: T, index: number) => boolean): T | undefined {',
    '    let index = 0',
    '    for (const item of this.#items.values()) if (predicate(item, index++)) return item',
    '    return undefined',
    '  }',
    '',
    '  get size(): number {',
    '    return this.#items.size',
    '  }',
    '',
    '  describe(): string {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: generated source, a template literal in it
    '    return `${this.prefix}#${this.#version}: ${[...this.#items.keys()].join(",")}`',
    '  }',
    '}',
    '',
    `export async function load${pad(index)}(ids: readonly number[], signal?: AbortSignal): Promise<${name}[]> {`,
    `  const out: ${name}[] = []`,
    '  for (const id of ids.slice(0, DEFAULTS.limit)) {',
    '    if (signal?.aborted === true) break',
    `    out.push({ id, kind: Kind${pad(index)}.Variant${randomBelow(random, 3)}, field0: \`item \${id}\` })`,
    '    await Promise.resolve()',
    '  }',
    '  return out',
    '}',
    '',
    `export function score(seed: number, record?: Partial${pad(index)}<${name}>): number {`,
    `  const base: number = seed * ${1 + randomBelow(random, 9)} + (record?.id ?? 0)`,
    ...deps.map(
      (dep) => `  const from${pad(dep)}: Record${pad(dep)}['id'] = score${pad(dep)}(seed + ${dep})`,
    ),
    ...(pkg === undefined ? [] : [`  const fromPackage = String(${pkg[1]}).length`]),
    ...(builtin === undefined ? [] : [`  const fromBuiltin = String(${builtin[1]}).length`]),
    `  return [base${deps.map((dep) => `, from${pad(dep)}`).join('')}${pkg === undefined ? '' : ', fromPackage'}${builtin === undefined ? '' : ', fromBuiltin'}].reduce((sum, value) => sum + value, 0) % 1_000_003`,
    '}',
    '',
  )
  return lines.join('\n')
}

/**
 * Every file of the corpus, as pure data: `src/m000.ts` to `src/m119.ts`.
 * @public
 */
export function tsCorpusFiles(): readonly GeneratedFile[] {
  const random = seededRandom(TS_CORPUS_SEED)
  return Array.from({ length: TS_CORPUS_FILES }, (_, index) => ({
    path: `src/m${pad(index)}.ts`,
    contents: module(index, random),
  }))
}
